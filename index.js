var pump = require('pump')
var TimeoutStream = require('through-timeout')
var cbTimeout = require('callback-timeout')
var mime = require('mime')
var rangeParser = require('range-parser')
var ndjson = require('ndjson')
var encoding = require('dat-encoding')

module.exports = HyperdriveHttp

function HyperdriveHttp (getArchive) {
  var singleArchive = false
  if (typeof (getArchive) !== 'function') {
    var archive = getArchive
    singleArchive = true
    getArchive = function (datUrl, cb) {
      cb(null, archive)
    }
  }
  var onrequest = function (req, res) {
    var datUrl = parse(req.url)
    if (!datUrl) return onerror(404, res)
    getArchive(datUrl, function (err, archive) {
      if (err) return onerror(err)
      archiveResponse(datUrl, archive, req, res)
    })
  }

  return onrequest

  function parse (url) {
    var segs = url.split('/').filter(Boolean)
    var key = segs[0]
    var filename = segs[1]
    try {
      encoding.decode(key)
    } catch (_) {
      if (!singleArchive) return null
    }
    if (singleArchive) filename = url.slice(1)

    return {
      key: key,
      filename: filename
    }
  }
}

function archiveResponse (datUrl, archive, req, res) {
  if (!archive) onerror(404, res)

  if (!datUrl.filename) {
    var src = archive.list({live: false})
    var timeout = TimeoutStream({
      objectMode: true,
      duration: 10000
    }, () => {
      onerror(404, res)
      src.destroy()
    })
    pump(src, timeout, ndjson.serialize(), res)
  }

  archive.get(datUrl.filename, cbTimeout((err, entry) => {
    if (err && err.code === 'ETIMEOUT') return onerror(404, res)
    if (err || !entry || entry.type !== 'file') return onerror(404, res)

    var range = req.headers.range && rangeParser(entry.length, req.headers.range)[0]

    res.setHeader('Access-Ranges', 'bytes')
    res.setHeader('Content-Type', mime.lookup(datUrl.filename))

    if (!range || range < 0) {
      res.setHeader('Content-Length', entry.length)
      if (req.method === 'HEAD') return res.end()
      pump(archive.createFileReadStream(entry), res)
    } else {
      res.statusCode = 206
      res.setHeader('Content-Length', range.end - range.start + 1)
      res.setHeader('Content-Range', 'bytes ' + range.start + '-' + range.end + '/' + entry.length)
      if (req.method === 'HEAD') return res.end()
      pump(archive.createFileReadStream(entry, {start: range.start, end: range.end + 1}), res)
    }
  }, 10000))
}

function onerror (status, res) {
  res.statusCode = status
  res.end()
}
