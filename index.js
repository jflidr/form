/*
 * @copyright Copyright (c) 2020 Ubiquiti Networks, Inc.
 * @see https://www.ubnt.com/
 */

'use strict';

const { Server } = require('@hapi/hapi');
const joi = require('joi');
const uuid = require('uuid');
const bunyan = require('bunyan');
const bunyanFormat = require('bunyan-format');
const good = require('@hapi/good');
const goodBunyan = require('good-bunyan');
const { Form } = require('multiparty');
const Boom = require('@hapi/boom');

const log = bunyan.createLogger({
  name: 'API',
  level: 'trace',
  stream: bunyanFormat({ outputMode: 'short' }),
  serializers: bunyan.stdSerializers,
});

const goodConfig = {
  ops: {
    interval: 5000,
  },
  includes: {
    request: ['payload'],
    response: ['payload'],
  },
  reporters: {
    consoleReporter: [
      {
        module: goodBunyan,
        args: [
          { ops: '*', error: '*', warn: '*', log: ['info', 'error'], request: '*', response: '*' },
          {
            logger: log,
            levels: { ops: 'info' },
            formatters: {
              response: data => [
                { level: 10 },
                `[response] ${data.method.toUpperCase()} ${data.path} ${data.statusCode} (${data.responseTime}ms)`,
              ],
            },
          },
        ],
      },
    ],
  },
};

const server = new Server({
  port: process.env.HTTP_PORT || 8080,
  routes: {
    cors: {
      origin: ['*'],
      exposedHeaders: [],
    },
  },
});

let fileCounter = 1;
const data = {};

server.route({
  method: 'GET',
  path: '/data',
  config: {
    description: 'Data',
    handler() {
      return Object.values(data).filter(item => item.file);
    },
  },
});

server.route({
  method: 'POST',
  path: '/submit',
  config: {
    description: 'Submit form',
    validate: {
      payload: joi
        .object()
        .keys({
          name: joi
            .string()
            .min(1)
            .max(100)
            .required(),
          height: joi
            .number()
            .integer()
            .positive()
            .max(500),
        }),
    },
    handler(request) {
      const uploadId = uuid.v4();
      const { name, height } = request.payload;
      data[uploadId] = { name, height, file: null };
      return {
        uploadId,
      }
    },
  },
});

server.route({
  method: 'POST',
  path: '/upload/{file}',
  config: {
    description: 'Upload file',
    validate: {
      params: joi.object({
        file: joi.string().guid().required(),
      }),
    },
    payload: {
      allow: 'multipart/form-data',
      maxBytes: 10 * 1024 * 1024,
      output: 'stream',
      parse: false,
    },
    handler: function (request) {
      return new Promise((resolve, reject) => {
        const form = new Form();
        let failed = false;
        let hasContent = false;
        let uploadedFilename = null

        form.on('error', error => reject(Boom.boomify(error, { statusCode: 400 })));
        form.on('close', () => {
          if (!data[request.params.file]) {
            reject(Boom.badRequest(`Unknown upload ID ${request.params.file}`))
          } else if (failed || !hasContent) {
            reject(Boom.badData('Sent invalid payload'));
          } else {
            data[request.params.file].file = uploadedFilename || `uploaded-file-${fileCounter++}.file`;
            resolve({
              result: true,
            })
          }
        });
        form.on('part', part => {
          hasContent = true;
          failed = failed || part.name !== 'file' || !part.filename;
          uploadedFilename = part.filename;
          part.resume();
        });

        form.parse(request.raw.req);
      });
    },
  },
});

const start = () => server.register([
  {
    plugin: good,
    options: goodConfig,
  },
]).then(() => server.initialize())
  .then(() => server.start())
  .then(() => log.info(`HTTP Server listening on ${server.info.uri}`));

start().catch(console.error);
