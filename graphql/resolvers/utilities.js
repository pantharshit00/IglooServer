import jwt from 'jwt-simple'
import moment from 'moment'
import chalk from 'chalk'
import OTP from 'otp.js'
import fortuna from 'javascript-fortuna'
import { withFilter } from 'graphql-subscriptions'
import winston from 'winston'
import AWS from 'aws-sdk'

require('dotenv').config()

/* istanbul ignore if */
if (!process.env.JWT_SECRET) {
  throw new Error('Could not load .env')
}

const ses = new AWS.SES({ region: 'eu-west-1' })

const { combine, timestamp, printf } = winston.format

const formatString = info =>
  `${info.timestamp} [${info.label ? info.label : 'generic'}${chalk.bold(info.code ? ` ${info.code}` : '')}] ${info.level}: ${info.message}`

const colorizedFormat = printf((info) => {
  /* istanbul ignore next */
  const colorizer =
    info.level === 'error'
      ? chalk.red
      : info.level === 'warn'
        ? chalk.yellow
        : info.level === 'info' ? chalk.blue : id => id

  return colorizer(formatString(info))
})
const logger = winston.createLogger({
  level: 'verbose',
  transports: [
    new winston.transports.Console({
      format: combine(timestamp(), colorizedFormat),
    }),
    new winston.transports.File({
      filename: 'logs.log',
      format: combine(timestamp(), printf(formatString)), // do not colorize file logs
    }),
  ],
})

const GA = OTP.googleAuthenticator
const JWT_EXPIRE_DAYS = 7

fortuna.init()

const authenticated = (
  context,
  callback,
  acceptedTokenTypes = ['TEMPORARY', 'PERMANENT'],
) =>
  (context.auth && acceptedTokenTypes.indexOf(context.auth.tokenType) > -1
    ? callback
    : (resolve, reject) => {
      if (!context.auth) {
        reject('You are not authenticated. Use `AuthenticateUser` to obtain an authentication token')
      } else if (context.auth.tokenType === 'SWITCH_TO_PAYING') {
        reject('You exceeded the free usage quota')
      } else if (context.auth.tokenType === 'CHANGE_USAGE_CAP') {
        reject('You exceeded the usage cap that you set')
      } else reject("This token doesn't have the required authorizations")
    })

const generateAuthenticationToken = (userId, JWT_SECRET) =>
  jwt.encode(
    {
      exp: moment()
        .utc()
        .add({ days: JWT_EXPIRE_DAYS })
        .unix(),
      userId,
      accessLevel: 'OWNER',
      tokenType: 'TEMPORARY',
    },
    JWT_SECRET,
    'HS512',
  )

const generatePermanentAuthenticationToken = (
  userId,
  tokenId,
  accessLevel,
  JWT_SECRET,
) =>
  jwt.encode(
    {
      userId,
      tokenId,
      accessLevel: accessLevel || 'DEVICE',
      tokenType: 'PERMANENT',
    },
    JWT_SECRET,
    'HS512',
  )

const generatePasswordRecoveryToken = (userId, JWT_SECRET) =>
  jwt.encode(
    {
      exp: moment()
        .utc()
        .add({ hours: 1 })
        .unix(),
      userId,
      accessLevel: 'OWNER',
      tokenType: 'PASSWORD_RECOVERY',
    },
    JWT_SECRET,
    'HS512',
  )

const retrieveScalarProp = (Model, prop) => (root, args, context) =>
  new Promise(authenticated(context, async (resolve, reject) => {
    try {
      const resourceFound = await Model.find({
        where: { id: root.id },
      })
      /* istanbul ignore next */
      if (!resourceFound) {
        reject('The requested resource does not exist')
      } else if (resourceFound.userId !== context.auth.userId) {
        /* istanbul ignore next */
        reject('You are not allowed to access details about this resource')
      } else {
        resolve(resourceFound[prop])
      }
    } catch (e) /* istanbul ignore next */ {
      logger.error(e, { label: 'retrieveScalarProp', code: 109 })
      reject('109 - An internal error occured, please contact us. The error code is 109')
    }
  }))

const getPropsIfDefined = (args, props) => {
  const propObject = {}
  for (let i = 0; i < props.length; i += 1) {
    if (args[props[i]] !== undefined && args[props[i]] !== null) {
      propObject[props[i]] = args[props[i]]
    }
  }

  return propObject
}

const MUTATION_COST = 2
// generic resolver for CreateXValue mutations
const CreateGenericValue = (Device, Board, Model, ValueModels, pubsub) => (
  root,
  args,
  context,
) =>
  logErrorsPromise(
    'CreateGenericValue',
    112,
    authorized(
      args.deviceId,
      context,
      Device,
      2,
      async (resolve, reject, deviceFound, deviceAndParent) => {
        async function calculateIndex() {
          const valuesCountPromises = ValueModels.map(async model =>
            await model.count({ where: { deviceId: args.deviceId } }))
          const valuesCount = await Promise.all(valuesCountPromises)

          const newIndex = valuesCount.reduce((a, b) => a + b)
          return newIndex
        }

        const index =
          args.index !== null && args.index !== undefined
            ? args.index
            : await calculateIndex()

        const newValue = (await Model.create({
          ...args,
          tileSize: args.tileSize || 'NORMAL',
          ownerId: context.auth.userId,
          adminsIds: [],
          editorsIds: [],
          spectatorsIds: [],
          index,
        })).dataValues

        const resolveObj = {
          ...newValue,
          user: {
            id: newValue.userId,
          },
          device: {
            id: newValue.deviceId,
          },
        }

        pubsub.publish('valueCreated', {
          valueCreated: resolveObj,
          userIds: instancesToSharedIds(deviceAndParent),
        })

        resolve(resolveObj)
        context.billingUpdater.update(MUTATION_COST)
      },
      deviceToParents(Board),
    ),
  )

const logErrorsPromise = (name, code, callback) =>
  new Promise(async (resolve, reject) => {
    try {
      await callback(resolve, reject)
    } catch (e) /* istanbul ignore next */ {
      if (e.parent && e.parent.routine === 'string_to_uuid') {
        reject(new Error('The ID you provided is not a valid ID, check for typing mistakes'))
      } else {
        logger.error(e.toString(), { label: name, code })
        reject(new Error(`${code} - An internal error occured, please contact us. The error code is ${code}`))
      }
    }
  })

const genericValueMutation = (
  childModel,
  __resolveType,
  pubsub,
  Device,
  Board,
) => (root, args, context) =>
  logErrorsPromise(
    'genericValue mutation',
    117,
    authorized(
      args.id,
      context,
      childModel,
      2,
      async (resolve, reject, valueFound, valueAndParents) => {
        const newValue = await valueFound.update(args)
        const resolveObj = {
          ...newValue.dataValues,
          user: {
            id: newValue.dataValues.userId,
          },
          device: {
            id: newValue.dataValues.deviceId,
          },
        }
        resolve(resolveObj)

        pubsub.publish('valueUpdated', {
          valueUpdated: { ...resolveObj, __resolveType },
          userIds: instancesToSharedIds(valueAndParents),
        })
        context.billingUpdater.update(MUTATION_COST)
      },
      valueToParents(Device, Board),
    ),
  )

const create2FSecret = (user) => {
  const allowedChars = 'QWERTYUIOPASDFGHJKLZXCVBNM234567'
  let secret = ''
  for (let i = 0; i < 12; i += 1) {
    const randomNumber = Math.floor(fortuna.random() * allowedChars.length)
    secret += allowedChars[randomNumber]
  }
  secret = GA.encode(secret)
  return { secret, qrCode: GA.qrCode(user, 'igloo', secret) }
}
const check2FCode = (code, secret) => {
  try {
    const { delta } = GA.verify(code, secret)
    return Math.abs(delta) < 3
  } catch (e) {
    return false
  }
}

const subscriptionFilterOnlyMine = (subscriptionName, pubsub) => ({
  subscribe: (root, args, context, info) => {
    if (context.auth) {
      const myUserId = context.auth.userId
      return withFilter(
        () => pubsub.asyncIterator(subscriptionName),
        payload => payload.userId === myUserId,
      )(root, args, context, info)
    }
    throw new Error('No authorization token')
  },
})

const subscriptionFilterOwnedOrShared = (subscriptionName, pubsub) => ({
  subscribe: (root, args, context, info) => {
    if (context.auth) {
      const myUserId = context.auth.userId
      return withFilter(
        () => pubsub.asyncIterator(subscriptionName),
        payload => payload.userIds.indexOf(myUserId) !== -1,
      )(root, args, context, info)
    }
    throw new Error('No authorization token')
  },
})

// races promises returning the first resolve or all the rejects if none resolves
const firstResolve = promises =>
  new Promise((resolve, reject) => {
    const errors = []
    let count = 0
    let resolved = false
    promises.forEach((promise, idx) => {
      promise
        .then((found) => {
          if (!resolved) {
            resolved = true
            resolve(found)
          }
        })
        /* istanbul ignore next */

        .catch((err) => {
          errors[idx] = err
          count += 1
          if (count === promises.length) {
            reject(errors)
          }
        })
    })
  })

// !! doesn't check if the user has the authorizations needed
const findAllValues = (
  {
    BoolValue,
    FloatValue,
    StringValue,
    ColourValue,
    PlotValue,
    StringPlotValue,
    MapValue,
  },
  query,
  userId,
) => {
  const booleanValues = BoolValue.findAll(query)
  const floatValues = FloatValue.findAll(query)
  const stringValues = StringValue.findAll(query)
  const colourValues = ColourValue.findAll(query)
  const plotValues = PlotValue.findAll(query)
  const stringPlotValues = StringPlotValue.findAll(query)
  const mapValues = MapValue.findAll(query)

  return Promise.all([
    booleanValues,
    floatValues,
    stringValues,
    colourValues,
    plotValues,
    stringPlotValues,
    mapValues,
  ]).then(([
    booleanValues,
    floatValues,
    stringValues,
    colourValues,
    plotValues,
    stringPlotValues,
    mapValues,
  ]) => [
    ...booleanValues.map(value => ({
      ...value.dataValues,
      owner: { id: value.dataValues.ownerId },
      device: { id: value.dataValues.deviceId },
      __resolveType: 'BooleanValue',
    })),
    ...floatValues.map(value => ({
      ...value.dataValues,
      owner: { id: value.dataValues.ownerId },
      device: { id: value.dataValues.deviceId },
      __resolveType: 'FloatValue',
    })),
    ...stringValues.map(value => ({
      ...value.dataValues,
      owner: { id: value.dataValues.ownerId },
      device: { id: value.dataValues.deviceId },
      __resolveType: 'StringValue',
    })),
    ...colourValues.map(value => ({
      ...value.dataValues,
      owner: { id: value.dataValues.ownerId },
      device: { id: value.dataValues.deviceId },
      __resolveType: 'ColourValue',
    })),
    ...plotValues.map(value => ({
      ...value.dataValues,
      owner: { id: value.dataValues.ownerId },
      device: { id: value.dataValues.deviceId },
      __resolveType: 'PlotValue',
    })),
    ...stringPlotValues.map(value => ({
      ...value.dataValues,
      owner: { id: value.dataValues.ownerId },
      device: { id: value.dataValues.deviceId },
      __resolveType: 'StringPlotValue',
    })),
    ...mapValues.map(value => ({
      ...value.dataValues,
      owner: { id: value.dataValues.ownerId },
      device: { id: value.dataValues.deviceId },
      __resolveType: 'MapValue',
    })),
  ])
}

// try refactoring this with firstResolve
const findValue = (
  {
    BoolValue,
    FloatValue,
    StringValue,
    ColourValue,
    PlotValue,
    StringPlotValue,
    MapValue,
  },
  Device,
  Board,
  query,
  userId,
) => {
  const booleanValue = BoolValue.find(query).then(value =>
    (value
      ? {
        ...value.dataValues,
        user: { id: value.dataValues.userId },
        device: { id: value.dataValues.deviceId },
        __resolveType: 'BooleanValue',
      }
      : value))
  const floatValue = FloatValue.find(query).then(value =>
    (value
      ? {
        ...value.dataValues,
        user: { id: value.dataValues.userId },
        device: { id: value.dataValues.deviceId },
        __resolveType: 'FloatValue',
      }
      : value))
  const stringValue = StringValue.find(query).then(value =>
    (value
      ? {
        ...value.dataValues,
        user: { id: value.dataValues.userId },
        device: { id: value.dataValues.deviceId },
        __resolveType: 'StringValue',
      }
      : value))
  const colourValue = ColourValue.find(query).then(value =>
    (value
      ? {
        ...value.dataValues,
        user: { id: value.dataValues.userId },
        device: { id: value.dataValues.deviceId },
        __resolveType: 'ColourValue',
      }
      : value))

  const mapValue = MapValue.find(query).then(value =>
    (value
      ? {
        ...value.dataValues,
        user: { id: value.dataValues.userId },
        device: { id: value.dataValues.deviceId },
        __resolveType: 'MapValue',
      }
      : value))

  const plotValue = PlotValue.find(query).then(value =>
    (value
      ? {
        ...value.dataValues,
        user: { id: value.dataValues.userId },
        device: { id: value.dataValues.deviceId },
        __resolveType: 'PlotValue',
      }
      : value))

  const stringPlotValue = StringPlotValue.find(query).then(value =>
    (value
      ? {
        ...value.dataValues,
        user: { id: value.dataValues.userId },
        device: { id: value.dataValues.deviceId },
        __resolveType: 'StringPlotValue',
      }
      : value))

  return Promise.all([
    booleanValue,
    floatValue,
    stringValue,
    colourValue,
    mapValue,
    plotValue,
  ])
    .then(values => values.reduce((acc, val) => val || acc, null))
    .then(async (value) => {
      if (!value) throw new Error('The requested resource does not exist')
      else {
        const deviceFound = await Device.find({
          where: { id: value.deviceId },
        })
        const boardFound = deviceFound.boardId
          ? await Board.find({
            where: { id: deviceFound.boardId },
          })
          : null

        if (
          authorizationLevel(
            boardFound
              ? [value, deviceFound, boardFound]
              : [value, deviceFound],
            userId,
          ) < 1
        ) {
          throw new Error('You are not allowed to access details about this resource')
        } else return value
      }
    })
}

const socketToDeviceMap = {}

const sendVerificationEmail = (email, userId) => {
  // TODO: use different jwt secrets?
  const verificationToken = jwt.encode(
    {
      userId,
      email,
      tokenType: 'EMAIL_VERIFICATION',
    },
    process.env.JWT_SECRET,
    'HS512',
  )

  const GRAPHQL_PORT = process.env.PORT || 3000
  const serverLink =
    process.env.NODE_ENV === 'production'
      ? 'https://iglooql.herokuapp.com/verifyEmail/'
      : `http://localhost:${GRAPHQL_PORT}/verifyEmail/`
  const emailVerificationLink = serverLink + verificationToken

  // TODO: create a template for the email verification
  ses.sendEmail(
    {
      Source: "'Igloo Cloud' <verification@igloo.ooo>",
      Destination: { ToAddresses: [email] },
      Message: {
        Body: {
          Html: {
            Charset: 'UTF-8',
            Data: `Verify your account clicking this link: <a href="${emailVerificationLink}">VERIFY</a>`,
          },
          Text: {
            Charset: 'UTF-8',
            Data: `Verify your account visiting this link: ${emailVerificationLink}`,
          },
        },
        Subject: {
          Charset: 'UTF-8',
          Data: 'Verify your account',
        },
      },
    },
    console.log,
  )
}

const sendPasswordRecoveryEmail = (email, userId) => {
  // TODO: use different jwt secrets?
  const recoveryToken = generatePasswordRecoveryToken(
    userId,
    process.env.JWT_SECRET,
  )

  // TODO: update this with the real link
  const emailRecoverylink = `https://igloocloud.github.io/IglooAurora/recovery/${recoveryToken}`

  // TODO: create a template for the email verification
  ses.sendEmail(
    {
      Source: "'Igloo Cloud' <recovery@igloo.ooo>",
      Destination: { ToAddresses: [email] },
      Message: {
        Body: {
          Html: {
            Charset: 'UTF-8',
            Data: `Change your password clicking this link: <a href="${emailRecoverylink}">Recover password</a>`,
          },
          Text: {
            Charset: 'UTF-8',
            Data: `Change your password at this link: ${emailRecoverylink}`,
          },
        },
        Subject: {
          Charset: 'UTF-8',
          Data: 'Recover your password',
        },
      },
    },
    console.log,
  )
}

const sendPasswordUpdatedEmail = (email) => {
  // TODO: create a template for the email verification
  ses.sendEmail(
    {
      Source: "'Igloo Cloud' <security@igloo.ooo>",
      Destination: { ToAddresses: [email] },
      Message: {
        Body: {
          Html: {
            Charset: 'UTF-8',
            Data:
              'Your password has been changed, if it was you that changed it you can ignore this email',
          },
          Text: {
            Charset: 'UTF-8',
            Data:
              'Your password has been changed, if it was you that changed it you can ignore this email',
          },
        },
        Subject: {
          Charset: 'UTF-8',
          Data: 'Password has been changed',
        },
      },
    },
    console.log,
  )
}

const sendTokenCreatedEmail = (email) => {
  // TODO: create a template for the email verification
  ses.sendEmail(
    {
      Source: "'Igloo Cloud' <security@igloo.ooo>",
      Destination: { ToAddresses: [email] },
      Message: {
        Body: {
          Html: {
            Charset: 'UTF-8',
            Data:
              'A new permanent token has been created, if it was you that created it you can ignore this email',
          },
          Text: {
            Charset: 'UTF-8',
            Data:
              'A new permanent token has been created, if it was you that created it you can ignore this email',
          },
        },
        Subject: {
          Charset: 'UTF-8',
          Data: 'A new permanent token has been created',
        },
      },
    },
    console.log,
  )
}

const scalarPropsResolvers = (Model, props) =>
  props.reduce((acc, prop) => {
    acc[prop] = retrieveScalarProp(Model, prop)
    return acc
  }, {})

async function instanceAuthorizationLevel(instance, userFound) {
  const modelNameLowerCase = instance._modelOptions.name.singular
  const ModelName =
    modelNameLowerCase[0].toUpperCase() + modelNameLowerCase.slice(1)

  const isOwner = await userFound[`hasOwn${ModelName}`](instance)
  const isAdmin = await userFound[`hasAdmin${ModelName}`](instance)
  const isEditor = await userFound[`hasEditor${ModelName}`](instance)
  const isSpectator = await userFound[`hasSpectator${ModelName}`](instance)

  if (isOwner) return 4
  else if (isAdmin) return 3
  else if (isEditor) return 2
  else if (isSpectator) return 1
  return 0
}

function authorizationLevel(instances, userFound) {
  const authorizations = instances.map(instance =>
    instanceAuthorizationLevel(instance, userFound))
  const maxAuthorization = Math.max(...authorizations)

  return maxAuthorization
}

function authorized(
  id,
  context,
  Model,
  User,
  authorizationRequired,
  callback,
  childToParents = found => Promise.resolve([]),
  acceptedTokenTypes,
) {
  return authenticated(
    context,
    async (resolve, reject) => {
      const found = await Model.find({ where: { id } })
      const others = await childToParents(found)

      const userFound = await User.find({ where: { id: context.auth.id } })

      if (!found) {
        reject('The requested resource does not exist')
      } else if (
        authorizationLevel([found, ...others], userFound) <
        authorizationRequired
      ) {
        /* istanbul ignore next */
        reject('You are not allowed to access details about this resource')
      } else {
        return callback(resolve, reject, found, [found, ...others])
      }
    },
    acceptedTokenTypes,
  )
}

const authorizedRetrieveScalarProp = (
  Model,
  User,
  prop,
  childToParents,
  acceptedTokenTypes,
) => (root, args, context) =>
  logErrorsPromise(
    'authorizedRetrieveScalarProp',
    920,
    authorized(
      root.id,
      context,
      Model,
      User,
      1,
      async (resolve, reject, resourceFound) => {
        resolve(resourceFound[prop])
      },
      childToParents,
      acceptedTokenTypes,
    ),
  )

const authorizedScalarPropsResolvers = (
  Model,
  User,
  props,
  childToParents,
  acceptedTokenTypes,
) =>
  props.reduce((acc, prop) => {
    acc[prop] = authorizedRetrieveScalarProp(
      Model,
      User,
      prop,
      childToParents,
      acceptedTokenTypes,
    )
    return acc
  }, {})

const QUERY_COST = 1
const rolesResolver = (roleIdsField, Model, childToParents) => (
  root,
  args,
  context,
) =>
  logErrorsPromise(
    'rolesIds resolver',
    922,
    authorized(
      root.id,
      context,
      Model,
      1,
      async (resolve, reject, found) => {
        const users = found[roleIdsField].map(id => ({
          id,
        }))

        resolve(users)

        context.billingUpdater.update(QUERY_COST * users.length)
      },
      childToParents,
    ),
  )

// FIXME: will those work??
const deviceToParents = Board => async (deviceFound) => {
  const boardFound = deviceFound.boardId
    ? await Board.find({ where: { id: deviceFound.boardId } })
    : null

  if (boardFound) return [boardFound]
  return []
}

const valueToParents = (Device, Board) => async (valueFound) => {
  const deviceFound = await Device.find({
    where: { id: valueFound.deviceId },
  })
  const boardFound = deviceFound.boardId
    ? await Board.find({ where: { id: deviceFound.boardId } })
    : null

  return boardFound ? [deviceFound, boardFound] : [deviceFound]
}

const authorizedValue = (
  id,
  context,
  Values,
  User,
  authorizationRequired,
  callbackFunc,
  Device,
  Board,
) =>
  authenticated(context, async (resolve, reject) => {
    const NOT_ALLOWED =
      'You are not allowed to access details about this resource'
    const NOT_EXIST = 'The requested resource does not exist'
    const models = Object.values(Values)

    const userFound = await User.find({ where: { id: context.auth.userId } })

    const findPromises = models.map(async (Model) => {
      const resourceFound = await Model.find({
        where: { id },
      })

      if (!resourceFound) {
        throw new Error(NOT_EXIST)
      } else {
        const deviceFound = await Device.find({
          where: { id: resourceFound.deviceId },
        })
        const boardFound = deviceFound.boardId
          ? await Board.find({
            where: { id: deviceFound.boardId },
          })
          : null

        const valueAndParents = boardFound
          ? [resourceFound, deviceFound, boardFound]
          : [resourceFound, deviceFound]
        if (
          authorizationLevel(valueAndParents, userFound) < authorizationRequired
        ) {
          throw new Error(NOT_ALLOWED)
        } else {
          return [resourceFound, valueAndParents]
        }
      }
    })
    // race all the models to find the looked for id, if a value is found
    // it is returned otherwise the correct error is returned
    const resourcesFound = await firstResolve(findPromises).catch((e) => {
      // choose the correct error, because normally most models
      // will reject with NOT_EXIST, simply because the value
      // looked for is of another type

      reject(e.reduce(
        (acc, val) =>
          (acc === NOT_ALLOWED || val === NOT_ALLOWED
            ? NOT_ALLOWED
            : NOT_EXIST),
        NOT_EXIST,
      ))
    })

    return callbackFunc(resolve, reject, ...resourcesFound)
  })

const instanceToRole = (instances, userFound) => {
  const roleLevel = authorizationLevel(instances, userFound)

  switch (roleLevel) {
    case 4:
      return 'OWNER'
    case 3:
      return 'ADMIN'
    case 2:
      return 'EDITOR'
    case 1:
      return 'SPECTATOR'
    case 0:
      return null
  }
}

// FIXME: no longer working
const instancesToSharedIds = instances =>
  instances.reduce(
    (acc, curr) => [
      ...acc,
      curr.ownerId,
      ...curr.adminsIds,
      ...curr.editorsIds,
      ...curr.spectatorsIds,
    ],
    [],
  )

const inheritAuthorized = (
  ownId,
  ownModel,
  ownIstanceToParentId,
  context,
  parentModel,
  authorizationRequired,
  callback,
  childToParents,
  acceptedTokenTypes,
) => async (resolve, reject) => {
  const entityFound = await ownModel.find({
    where: { id: ownId },
  })

  if (!entityFound) {
    throw new Error('The requested resource does not exist')
  } else {
    return authorized(
      ownIstanceToParentId(entityFound),
      context,
      parentModel,
      authorizationRequired,
      (resolve, reject, parentFound, allParents) =>
        callback(resolve, reject, entityFound, parentFound, allParents),
      childToParents,
      acceptedTokenTypes,
    )(resolve, reject)
  }
}

const inheritAuthorizedRetrieveScalarProp = (
  Model,
  prop,
  ownIstanceToParentId,
  parentModel,
  childToParents,
  acceptedTokenTypes,
) => (root, args, context) =>
  logErrorsPromise(
    'inheritAuthorizedRetrieveScalarProp',
    1003,
    inheritAuthorized(
      root.id,
      Model,
      ownIstanceToParentId,
      context,
      parentModel,
      1,
      (resolve, reject, resourceFound) => resolve(resourceFound[prop]),
      childToParents,
      acceptedTokenTypes,
    ),
  )

const inheritAuthorizedScalarPropsResolvers = (
  Model,
  props,
  ownIstanceToParentId,
  parentModel,
  childToParents,
  acceptedTokenTypes,
) =>
  props.reduce((acc, prop) => {
    acc[prop] = inheritAuthorizedRetrieveScalarProp(
      Model,
      prop,
      ownIstanceToParentId,
      parentModel,
      childToParents,
      acceptedTokenTypes,
    )
    return acc
  }, {})

module.exports = {
  authenticated,
  generateAuthenticationToken,
  retrieveScalarProp,
  CreateGenericValue,
  getPropsIfDefined,
  genericValueMutation,
  create2FSecret,
  check2FCode,
  logErrorsPromise,
  subscriptionFilterOnlyMine,
  logger,
  findAllValues,
  findValue,
  generatePermanentAuthenticationToken,
  socketToDeviceMap,
  sendVerificationEmail,
  generatePasswordRecoveryToken,
  sendPasswordRecoveryEmail,
  sendPasswordUpdatedEmail,
  sendTokenCreatedEmail,
  scalarPropsResolvers,
  authorizationLevel,
  authorized,
  authorizedScalarPropsResolvers,
  rolesResolver,
  deviceToParents,
  valueToParents,
  authorizedValue,
  firstResolve,
  instanceToRole,
  instancesToSharedIds,
  subscriptionFilterOwnedOrShared,
  inheritAuthorized,
  inheritAuthorizedScalarPropsResolvers,
}
