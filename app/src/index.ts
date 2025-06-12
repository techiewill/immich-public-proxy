#!/usr/bin/env node

import express from 'express'
import cookieSession from 'cookie-session'
import immich from './immich'
import crypto from 'crypto'
import render from './render'
import dayjs from 'dayjs'
import { Request, Response, NextFunction } from 'express-serve-static-core'
import { AssetType, ImageSize } from './types'
import { log, toString, addResponseHeaders, getConfigOption } from './functions'
import { decrypt, encrypt } from './encrypt'
import { respondToInvalidRequest } from './invalidRequestHandler'

require('dotenv').config()

declare module 'express-serve-static-core' {
  interface Request {
    password?: string;
  }
}

const app = express()

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept')
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204)
  }
  next()
})

app.use(cookieSession({
  name: 'session',
  httpOnly: true,
  sameSite: 'strict',
  secret: crypto.randomBytes(32).toString('base64url')
}))
app.set('view engine', 'ejs')
app.use(express.json())
app.use('/share/static', express.static('public', { setHeaders: addResponseHeaders }))
app.use(express.static('public', { setHeaders: addResponseHeaders }))
app.disable('x-powered-by')

const decodeCookie = (req: Request, _res: Response, next: NextFunction) => {
  const shareKey = req.params.key
  const session = req.session?.[shareKey]
  if (shareKey && session?.iv && session?.cr) {
    try {
      const payload = JSON.parse(decrypt({
        iv: toString(session.iv),
        cr: toString(session.cr)
      }))
      if (payload?.expires && dayjs(payload.expires) > dayjs()) {
        req.password = payload.password
      }
    } catch (e) {}
  }
  next()
}

app.get(/^(|\/share)\/healthcheck$/, async (_req, res) => {
  if (await immich.accessible()) {
    res.send('ok')
  } else {
    res.status(503).send()
  }
})

app.get('/share/:key/:mode(download)?', decodeCookie, async (req, res) => {
  await immich.handleShareRequest({
    req,
    key: req.params.key,
    mode: req.params.mode,
    password: req.password
  }, res)
})

app.post('/share/unlock', async (req, res) => {
  if (req.session && req.body.key) {
    req.session[req.body.key] = encrypt(JSON.stringify({
      password: req.body.password,
      expires: dayjs().add(1, 'hour').format()
    }))
  }
  res.send()
})

app.get('/share/:type(photo|video)/:key/:id/:size?', decodeCookie, async (req, res) => {
  addResponseHeaders(res)

  if (!immich.isKey(req.params.key) || !immich.isId(req.params.id)) {
    log('Invalid key or ID for ' + req.path)
    respondToInvalidRequest(res, 404)
    return
  }

  if (req.params.size && !Object.values(ImageSize).includes(req.params.size as ImageSize)) {
    log('Invalid size parameter ' + req.path)
    respondToInvalidRequest(res, 404)
    return
  }

  const sharedLink = (await immich.getShareByKey(req.params.key, req.password))?.link
  const request = {
    req,
    key: req.params.key,
    range: req.headers.range || ''
  }

  if (sharedLink?.assets?.length) {
    const asset = sharedLink.assets.find(x => x.id === req.params.id)
    if (asset) {
      asset.type = req.params.type === 'video' ? AssetType.video : AssetType.image
      render.assetBuffer(request, res, asset, req.params.size).then()
    } else {
      respondToInvalidRequest(res, 404)
    }
  } else {
    respondToInvalidRequest(res, 404)
  }
})

if (getConfigOption('ipp.showHomePage', true)) {
  app.get(/^\/(|share)\/*$/, (_req, res) => {
    addResponseHeaders(res)
    res.render('home')
  })
}

app.options('/share/:id/api', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept')
  res.sendStatus(200)
})

app.get('/share/:id/api', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')

  try {
    const shareKey = req.params.id
    const share = await immich.getShareByKey(shareKey, '')

    if (!share?.link || !share.link.assets.length) {
      return res.status(404).json({ error: 'Invalid or expired share key' })
    }

    const base = 'https://i.techie.pics'
    const page = parseInt(req.query.page as string) || 1
    const pageSize = parseInt(req.query.pageSize as string) || 20
    const start = (page - 1) * pageSize
    const pagedAssets = share.link.assets.slice(start, start + pageSize)

    const media = pagedAssets.map(asset => {
      return {
        id: asset.id,
        thumbUrl: `${base}/share/photo/${shareKey}/${asset.id}/thumbnail`,
        previewUrl: `${base}/share/photo/${shareKey}/${asset.id}/preview`,
        originalUrl: `${base}/share/photo/${shareKey}/${asset.id}/original`
      }
    })

    res.json({ media, page, pageSize, total: share.link.assets.length })
  } catch (err: any) {
    log('Failed to serve JSON gallery for key ' + req.params.id)
    res.status(404).json({ error: 'Invalid or expired share key' })
  }
})

app.get('*', (req, res) => {
  log('Invalid route ' + req.path)
  respondToInvalidRequest(res, 404)
})

process.on('uncaughtException', (err) => {
  console.error('There was an uncaught error', err)
  server.close()
  process.exit(1)
})
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason)
  server.close()
  process.exit(1)
})
process.on('SIGTERM', () => {
  console.log('Received SIGTERM. Gracefully shutting down...')
  server.close()
  process.exit(0)
})

const port = process.env.IPP_PORT || 3000
const server = app.listen(port, () => {
  console.log(dayjs().format() + ' Server started on port ' + port)
})
