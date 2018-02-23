/*
 * Copyright 2017 resin.io
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

const _ = require('lodash')
const ipc = require('node-ipc')
const EXIT_CODES = require('../../shared/exit-codes')
const errors = require('../../shared/errors')
const ImageWriter = require('../../sdk/writer')

ipc.config.id = process.env.IPC_CLIENT_ID
ipc.config.socketRoot = process.env.IPC_SOCKET_ROOT

// NOTE: Ensure this isn't disabled, as it will cause
// the stdout maxBuffer size to be exceeded when flashing
ipc.config.silent = true

// > If set to 0, the client will NOT try to reconnect.
// See https://github.com/RIAEvangelist/node-ipc/
//
// The purpose behind this change is for this process
// to emit a "disconnect" event as soon as the GUI
// process is closed, so we can kill this process as well.
ipc.config.stopRetrying = 0

const IPC_SERVER_ID = process.env.IPC_SERVER_ID

/**
 * @summary Send a log debug message to the IPC server
 * @function
 * @private
 *
 * @param {String} message - message
 *
 * @example
 * log('Hello world!')
 */
const log = (message) => {
  ipc.of[IPC_SERVER_ID].emit('log', message)
}

/**
 * @summary Terminate the child writer process
 * @function
 * @private
 *
 * @param {Number} [code=0] - exit code
 *
 * @example
 * terminate(1)
 */
const terminate = (code) => {
  ipc.disconnect(IPC_SERVER_ID)
  process.nextTick(() => {
    process.exit(code || EXIT_CODES.SUCCESS)
  })
}

/**
 * @summary Handle a child writer error
 * @function
 * @private
 *
 * @param {Error} error - error
 *
 * @example
 * handleError(new Error('Something bad happened!'))
 */
const handleError = (error) => {
  ipc.of[IPC_SERVER_ID].emit('error', errors.toJSON(error))
  terminate(EXIT_CODES.GENERAL_ERROR)
}

ipc.connectTo(IPC_SERVER_ID, () => {
  process.once('uncaughtException', handleError)

  // Gracefully exit on the following cases. If the parent
  // process detects that child exit successfully but
  // no flashing information is available, then it will
  // assume that the child died halfway through.

  process.once('SIGINT', () => {
    terminate(EXIT_CODES.SUCCESS)
  })

  process.once('SIGTERM', () => {
    terminate(EXIT_CODES.SUCCESS)
  })

  // The IPC server failed. Abort.
  ipc.of[IPC_SERVER_ID].on('error', () => {
    terminate(EXIT_CODES.SUCCESS)
  })

  // The IPC server was disconnected. Abort.
  ipc.of[IPC_SERVER_ID].on('disconnect', () => {
    terminate(EXIT_CODES.SUCCESS)
  })

  ipc.of[IPC_SERVER_ID].on('write', (options) => {
    log(`Image: ${options.imagePath}`)
    log(`Devices: ${options.destinations.join(', ')}`)
    log(`Umount on success: ${options.unmountOnSuccess}`)
    log(`Validate on success: ${options.validateWriteOnSuccess}`)

    let exitCode = EXIT_CODES.SUCCESS
    const writers = new Map()
    const results = []

    /**
     * @summary Progress handler
     * @param {Object} state - progress state
     * @example
     * writer.on('progress', onProgress)
     */
    const onProgress = (state) => {
      ipc.of[IPC_SERVER_ID].emit('state', state)
    }

    /**
     * @summary Finish handler
     * @param {Object} result - Flash result
     * @example
     * writer.on('finish', onFinish)
     */
    const onFinish = (result) => {
      log(`Finish: ${result.drive.device}`)

      if (result) {
        results.push(result)
        writers.delete(result.drive.device)
      }

      if (!writers.size) {
        ipc.of[IPC_SERVER_ID].emit('done', { results })
        terminate(exitCode)
      }
    }

    /**
     * @summary Error handler
     * @param {Error} error - error
     * @example
     * writer.on('error', onError)
     */
    const onError = (error) => {
      log(error.message)
      exitCode = EXIT_CODES.GENERAL_ERROR
      error.device = this.destinationDevice.device
      ipc.of[IPC_SERVER_ID].emit('error', error)

      // Call onFinish() here, as an errored writer has finished
      onFinish()
    }

    // TODO: Think about evaluating a few work-distributing mechanics;
    // 1) single process
    // 2) multi-process w/ 1 worker per writer
    // 3) cluster w/ 1 worker per core
    _.forEach(options.destinations, (destination) => {
      const writer = new ImageWriter({
        path: destination,
        imagePath: options.imagePath,
        verify: options.validateWriteOnSuccess,
        unmountOnSuccess: options.unmountOnSuccess,
        checksumAlgorithms: options.checksumAlgorithms
      })

      writers.set(destination, writer)

      writer.on('error', onError)
      writer.on('progress', onProgress)
      writer.on('finish', onFinish)

      writer.flash()
    })
  })

  ipc.of[IPC_SERVER_ID].on('connect', () => {
    log(`Successfully connected to IPC server: ${IPC_SERVER_ID}, socket root ${ipc.config.socketRoot}`)
    ipc.of[IPC_SERVER_ID].emit('ready', {})
  })
})
