/*
 * Copyright 2016 resin.io
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict'

const Bluebird = require('bluebird')
const visuals = require('resin-cli-visuals')
const form = require('resin-cli-form')
const bytes = require('pretty-bytes')
const ImageWriter = require('../sdk/writer')
const utils = require('./utils')
const options = require('./options')
const messages = require('../shared/messages')
const EXIT_CODES = require('../shared/exit-codes')
const errors = require('../shared/errors')
const permissions = require('../shared/permissions')

const ARGV_IMAGE_PATH_INDEX = 0
const imagePath = options._[ARGV_IMAGE_PATH_INDEX]

permissions.isElevated().then((elevated) => {
  if (!elevated) {
    throw errors.createUserError({
      title: messages.error.elevationRequired(),
      description: 'This tool requires special permissions to write to external drives'
    })
  }

  return form.run([
    {
      message: 'Select drive',
      type: 'drive',
      name: 'drive'
    },
    {
      message: 'This will erase the selected drive. Are you sure?',
      type: 'confirm',
      name: 'yes',
      default: false
    }
  ], {
    override: {
      drive: options.drive,

      // If `options.yes` is `false`, pass `null`,
      // otherwise the question will not be asked because
      // `false` is a defined value.
      yes: options.yes || null

    }
  })
}).then((answers) => {
  if (!answers.yes) {
    throw errors.createUserError({
      title: 'Aborted',
      description: 'We can\'t proceed without confirmation'
    })
  }

  const progressBars = {
    write: new visuals.Progress('Flashing'),
    check: new visuals.Progress('Validating')
  }

  return new Bluebird((resolve, reject) => {
    const results = []
    const writers = new Map()
    const states = new Map()
    const progress = {
      type: 'write',
      delta: 0,
      transferred: 0,
      percentage: 0,
      remaining: 0,
      runtime: 0,
      speed: 0,
      eta: 0,
      message: ''
    }

    const resetProgress = () => {
      progress.delta = 0
      progress.transferred = 0
      progress.percentage = 0
      progress.remaining = 0
      progress.runtime = 0
      progress.totalSpeed = 0
      progress.speed = 0
      progress.eta = 0
      progress.message = ''
    }

    const onProgress = (state) => {
      states.set(state.device, state)

      let writing = 0
      const length = states.size

      resetProgress()

      // Sum all states
      states.forEach((flash) => {
        writing += flash.type === 'write' ? 1 : 0
        progress.delta += flash.delta
        progress.transferred += flash.transferred
        progress.percentage += flash.percentage
        progress.remaining += flash.remaining
        progress.runtime += flash.runtime
        progress.speed += flash.speed
        progress.eta += flash.eta
      })

      // Average state
      progress.totalSpeed = progress.speed
      progress.type = writing > 0 ? 'write' : 'check'
      progress.delta /= length
      progress.transferred /= length
      progress.percentage /= length
      progress.remaining /= length
      progress.runtime /= length
      progress.speed /= length
      progress.eta /= length
      progress.message = length > 1 ?
        `${bytes(progress.totalSpeed)}/s total, ${bytes(progress.speed)}/s avg` :
        `${bytes(progress.speed)}/s`

      // Upfate progress bar
      progressBars[progress.type].update(progress)
    }

    const onError = function(error) {
      results.push({ device: this.options.path, error })
      writers.delete(this.options.path)
      states.delete(this.options.path)
      if(!writers.size) {
        resolve(results)
      }
    }

    const onFinish = function(state) {
      results.push({ device: this.options.path, flash: state })
      writers.delete(this.options.path)
      states.delete(this.options.path)
      if(!writers.size) {
        resolve(results)
      }
    }

    ;[].concat(answers.drive).forEach((drive) => {
      const writer = new ImageWriter({
        path: drive,
        imagePath,
        verify: options.check,
        unmountOnSuccess: options.unmount,
        checksumAlgorithms: [ 'crc32' ]
      })

      writers.set(drive, writer)

      writer.on('progress', onProgress)
      writer.on('error', onError)
      writer.on('finish', onFinish)

      writer.flash()
    })
  })
}).then((results) => {
  let exitCode = EXIT_CODES.SUCCESS
  console.log('Checksums:')

  results.forEach((result) => {
    if( result.error ) {
      exitCode = EXIT_CODES.GENERAL_ERROR
      console.log(`  - ${result.device}: ${result.error.message}`)
    } else {
      console.log(`  - ${result.device}: ${result.flash.checksum.crc32}`)
    }
  })

  process.exit(exitCode)

}).catch((error) => {
  return Bluebird.try(() => {
    utils.printError(error)
    return Bluebird.resolve()
  }).then(() => {
    if (error.code === 'EVALIDATION') {
      process.exit(EXIT_CODES.VALIDATION_ERROR)
    }

    process.exit(EXIT_CODES.GENERAL_ERROR)
  })
})
