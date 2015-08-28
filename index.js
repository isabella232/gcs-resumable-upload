'use strict'

var bufferEqual = require('buffer-equal')
var ConfigStore = require('configstore')
var googleAuth = require('google-auto-auth')
var Pumpify = require('pumpify')
var request = require('request')
var StreamEvents = require('stream-events')
var through = require('through2')
var util = require('util')

var BASE_URI = 'https://www.googleapis.com/upload/storage/v1/b'
var RESUMABLE_INCOMPLETE_STATUS_CODE = 308
var RETRY_LIMIT = 5

function Upload (cfg) {
  if (!(this instanceof Upload)) return new Upload(cfg)

  Pumpify.call(this)
  StreamEvents.call(this)

  var self = this
  cfg = cfg || {}

  if (!cfg.bucket || !cfg.file) {
    throw new Error('A bucket and file name are required')
  }

  cfg.authConfig = cfg.authConfig || {}
  cfg.authConfig.scopes = ['https://www.googleapis.com/auth/devstorage.full_control']
  this.authClient = cfg.authClient || googleAuth(cfg.authConfig)

  this.bucket = cfg.bucket
  this.file = cfg.file
  this.generation = cfg.generation
  this.metadata = cfg.metadata || {}

  this.configStore = new ConfigStore('gcs-resumable-upload')
  this.uri = cfg.uri || this.get('uri')
  this.numBytesWritten = 0
  this.numRetries = 0

  this.once('writing', function () {
    if (self.uri) self.continueUploading()
    else self.createResumableUpload()
  })
}

util.inherits(Upload, Pumpify)

Upload.prototype.createResumableUpload = function () {
  var self = this
  var metadata = this.metadata

  var reqOpts = {
    method: 'POST',
    uri: [BASE_URI, this.bucket, 'o'].join('/'),
    qs: {
      name: this.file,
      uploadType: 'resumable'
    },
    json: metadata
  }

  if (metadata.contentType) {
    reqOpts.headers = {
      'X-Upload-Content-Type': metadata.contentType
    }
  }

  if (this.generation) {
    reqOpts.qs.ifGenerationMatch = this.generation
  }

  this.makeRequest(reqOpts, function (err, resp) {
    if (err) return

    self.uri = resp.headers.location
    self.set({ uri: self.uri })

    self.offset = 0
    self.startUploading()
  })
}

Upload.prototype.continueUploading = function () {
  this.getAndSetOffset(this.startUploading.bind(this))
}

Upload.prototype.startUploading = function () {
  var self = this

  var reqOpts = {
    method: 'PUT',
    uri: this.uri,
    headers: {
      'Content-Range': 'bytes ' + this.offset + '-*/*'
    }
  }

  var bufferStream = this.bufferStream = through()
  var offsetStream = this.offsetStream = through(this.onChunk.bind(this))
  var delayStream = through()

  this.getRequestStream(reqOpts, function (requestStream) {
    self.setPipeline(bufferStream, offsetStream, requestStream, delayStream)

    // wait for "complete" from request before letting the stream finish
    delayStream.on('prefinish', function () { self.cork() })

    requestStream.on('complete', function (resp) {
      var body = resp.body

      try {
        body = JSON.parse(body)
      } catch (e) {}

      self.emit('response', resp, body)

      if (resp.statusCode < 200 || resp.statusCode > 299) {
        self.destroy(new Error('Upload failed'))
        return
      }

      self.deleteConfig()
      self.uncork()
    })
  })
}

Upload.prototype.onChunk = function (chunk, enc, next) {
  var offset = this.offset
  var numBytesWritten = this.numBytesWritten

  // check if this is the same content uploaded previously. this caches a slice
  // of the first chunk, then compares it with the first byte of incoming data
  if (numBytesWritten === 0) {
    var cachedFirstChunk = this.get('firstChunk')
    var firstChunk = chunk.slice(0, 16).valueOf()

    if (!cachedFirstChunk) {
      // This is a new upload. Cache the first chunk.
      this.set({
        uri: this.uri,
        firstChunk: firstChunk
      })
    } else {
      // this continues an upload in progress. check if the bytes are the same
      cachedFirstChunk = new Buffer(cachedFirstChunk)
      firstChunk = new Buffer(firstChunk)

      if (!bufferEqual(cachedFirstChunk, firstChunk)) {
        // this data is not the same. start a new upload
        this.bufferStream.unshift(chunk)
        this.bufferStream.unpipe(this.offsetStream)
        this.restart()
        return
      }
    }
  }

  var length = chunk.length

  if (typeof chunk === 'string') length = Buffer.byteLength(chunk, enc)
  if (numBytesWritten < offset) chunk = chunk.slice(offset - numBytesWritten)

  this.numBytesWritten += length

  // only push data from the byte after the one we left off on
  next(null, this.numBytesWritten > offset ? chunk : undefined)
}

Upload.prototype.getAndSetOffset = function (callback) {
  var self = this

  this.makeRequest({
    method: 'PUT',
    uri: this.uri,
    headers: {
      'Content-Length': 0,
      'Content-Range': 'bytes */*'
    }
  }, function (err, resp) {
    if (err) return

    if (resp.statusCode === RESUMABLE_INCOMPLETE_STATUS_CODE) {
      if (resp.headers.range) {
        self.offset = parseInt(resp.headers.range.split('-')[1], 10) + 1
        callback()
        return
      }
    }

    self.offset = 0
    callback()
  })
}

Upload.prototype.makeRequest = function (reqOpts, callback) {
  var self = this

  this.authClient.authorizeRequest(reqOpts, function (err, authorizedReqOpts) {
    if (err) return self.destroy(err)

    request(authorizedReqOpts, function (err, resp, body) {
      if (err) return self.destroy(err)

      var shouldContinue = self.onResponse(resp)
      if (shouldContinue) callback(err, resp, body)
    })
  })
}

Upload.prototype.getRequestStream = function (reqOpts, callback) {
  var self = this

  this.authClient.authorizeRequest(reqOpts, function (err, authorizedReqOpts) {
    if (err) return self.destroy(err)

    var requestStream = request(authorizedReqOpts)
    requestStream.on('error', self.destroy.bind(self))
    requestStream.on('response', self.onResponse.bind(self))

    // this makes the response body come back in the response (weird?)
    requestStream.callback = function () {}

    callback(requestStream)
  })
}

Upload.prototype.restart = function () {
  this.numBytesWritten = 0
  this.deleteConfig()
  this.startUploading()
}

Upload.prototype.get = function (prop) {
  var store = this.configStore.get(this.file)
  return store && store[prop]
}

Upload.prototype.set = function (props) {
  this.configStore.set(this.file, props)
}

Upload.prototype.deleteConfig = function () {
  this.configStore.del(this.file)
}

/**
 * @return {bool} is the request good?
 */
Upload.prototype.onResponse = function (resp) {
  if (resp.statusCode === 404) {
    if (this.numRetries < RETRY_LIMIT) {
      this.numRetries++
      this.startUploading()
    } else {
      this.destroy(new Error('Retry limit exceeded'))
    }
    return false
  }

  if (resp.statusCode > 499 && resp.statusCode < 600) {
    if (this.numRetries < RETRY_LIMIT) {
      var randomMs = Math.round(Math.random() * 1000)
      var waitTime = Math.pow(2, this.numRetries) * 1000 + randomMs

      this.numRetries++
      setTimeout(this.continueUploading.bind(this), waitTime)
    } else {
      this.destroy(new Error('Retry limit exceeded'))
    }
    return false
  }

  return true
}

module.exports = Upload