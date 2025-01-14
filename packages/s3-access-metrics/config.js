// Allow use of packages from devDependencies, since this file is not part of
// the deployed code.

/* eslint-disable node/no-unpublished-require */

'use strict';

const fs = require('fs');
const yaml = require('js-yaml');
const { promisify } = require('util');
const configHelpers = require('./configHelpers');

const readFile = promisify(fs.readFile);

// Load config.yml into a Javscript object
const loadConfig = () => readFile('./config.yml', 'utf8').then(yaml.safeLoad);

const getConfigValue = (name) =>
  (_serverless) => loadConfig().then(configHelpers[name]);

// Return deployToVpc as a string
const deployToVpc = (_serverless) =>
  loadConfig()
    .then(configHelpers.deployToVpc)
    .then((x) => `${x}`);

// The result of evaluating these functions is available in `serverless.yml` by
// using ${file(./config.js):propNameHere}
module.exports = {
  deployToVpc,
  logsPrefix: getConfigValue('logsPrefix'),
  permissionsBoundary: getConfigValue('permissionsBoundary'),
  vpcConfig: getConfigValue('vpcConfig'),
  logsBucket: getConfigValue('logsBucket'),
  prefix: getConfigValue('prefix'),
  stack: getConfigValue('stack'),
  subnetIds: getConfigValue('subnetIds'),
  vpcId: getConfigValue('vpcId')
};
