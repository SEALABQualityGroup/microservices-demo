// Copyright 2018 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

const path = require('path');
const grpc = require('grpc');
const pino = require('pino');
const protoLoader = require('@grpc/proto-loader');

const charge = require('./charge');

// tracing stuff
const tracing = require('@opencensus/nodejs');
const { plugin } = require('@opencensus/instrumentation-grpc');
const { ZipkinTraceExporter } = require('@opencensus/exporter-zipkin');
const { ConsoleExporter } = require('@opencensus/core');
const tracer = setupTracerAndExporters();

const logger = pino({
  name: 'paymentservice-server',
  messageKey: 'message',
  changeLevelName: 'severity',
  useLevelLabels: true
});


function setupTracerAndExporters () {
  // grab Zipkin address from env variables
  const ZIPKIN_SERVICE_ADDR = process.env['ZIPKIN_SERVICE_ADDR'];
  if (!ZIPKIN_SERVICE_ADDR) {
    console.warn('Unable to start Zipking, please define ZIPKIN_SERVICE_ADDR');
    return null
  }

  const defaultBufferConfig = {
    bufferSize: 1,
    bufferTimeout: 20000, // time in milliseconds
  };

  // Console exporter can print spans to stdout
  const consoleExporter = new ConsoleExporter(defaultBufferConfig);
  
  const zipkinOptions = {
    url: "http://" + ZIPKIN_SERVICE_ADDR + "/api/v2/spans",
    serviceName: 'paymentservice-server'
  };

  // Creates Zipkin exporter
  const exporter = new ZipkinTraceExporter(zipkinOptions);

  // Starts Stackdriver exporter
  tracing.registerExporter(exporter).start();

  // Starts tracing and set sampling rate
  const tracer = tracing.start({
    samplingRate: 1 // For demo purposes, always sample
  }).tracer;

  // Defines basedir and version
  const basedir = path.dirname(require.resolve('grpc'));
  const version = require(path.join(basedir, 'package.json')).version;

  // Enables GRPC plugin: Method that enables the instrumentation patch.
  // plugin.enable(grpc, tracer, version, /** plugin options */{}, basedir);

  return tracer;
}

class HipsterShopServer {
  constructor (protoRoot, port = HipsterShopServer.PORT) {
    this.port = port;

    this.packages = {
      hipsterShop: this.loadProto(path.join(protoRoot, 'demo.proto')),
      health: this.loadProto(path.join(protoRoot, 'grpc/health/v1/health.proto'))
    };

    this.server = new grpc.Server();
    this.loadAllProtos(protoRoot);
  }

  /**
   * Handler for PaymentService.Charge.
   * @param {*} call  { ChargeRequest }
   * @param {*} callback  fn(err, ChargeResponse)
   */
  static ChargeServiceHandler (call, callback) {
    tracer.startRootSpan({ name: 'grpc.hipstershop.PaymentService/Charge'}, rootSpan => {
      try {
        logger.info(`PaymentService#Charge invoked with request ${JSON.stringify(call.request)}`);
        const response = charge(call.request);
        callback(null, response);
      } catch (err) {
        console.warn(err);
        callback(err);
      }
      rootSpan.end();
    });
  }

  static CheckHandler (call, callback) {
    callback(null, { status: 'SERVING' });
  }

  listen () {
    this.server.bind(`0.0.0.0:${this.port}`, grpc.ServerCredentials.createInsecure());
    logger.info(`PaymentService grpc server listening on ${this.port}`);
    this.server.start();
  }

  loadProto (path) {
    const packageDefinition = protoLoader.loadSync(
      path,
      {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true
      }
    );
    return grpc.loadPackageDefinition(packageDefinition);
  }

  loadAllProtos (protoRoot) {
    const hipsterShopPackage = this.packages.hipsterShop.hipstershop;
    const healthPackage = this.packages.health.grpc.health.v1;

    this.server.addService(
      hipsterShopPackage.PaymentService.service,
      {
        charge: HipsterShopServer.ChargeServiceHandler.bind(this)
      }
    );

    this.server.addService(
      healthPackage.Health.service,
      {
        check: HipsterShopServer.CheckHandler.bind(this)
      }
    );
  };
}

HipsterShopServer.PORT = process.env.PORT;

module.exports = HipsterShopServer;
