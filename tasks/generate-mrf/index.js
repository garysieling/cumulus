'use strict';

const fs = require('fs');
const path = require('path');
const spawn = require('child_process').spawn;

const Task = require('gitc-common/task');
const log = require('gitc-common/log');
const util = require('gitc-common/util');
const aws = require('gitc-common/aws');
const configGen = require('./config-gen');

const LOCK_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
const execSync = require('child_process').execSync;


module.exports = class GenerateMrfTask extends Task {
  run() {
    return this.exclusive(this.transactionKey, LOCK_TIMEOUT_MS, this.runExclusive.bind(this));
  }

  async runExclusive() {
    const event = this.event;

    if (event.payload.length === 0) {
      log.info('No files to process');
      return this.complete(Object.assign({}, event, {
        files: []
      }));
    }
    const tempDir = util.mkdtempSync(this.constructor.name);

    try {
      const paths = {
        mrfgenConfig: path.join(tempDir, 'mrfgenConfig.xml'),
        templates: path.join(__dirname, 'templates')
      };

      for (const tempPath of ['work', 'input', 'output', 'logs', 'emptyTiles']) {
        paths[tempPath] = path.join(tempDir, tempPath);
        if (!fs.existsSync(paths[tempPath])) {
          fs.mkdirSync(paths[tempPath]);
        }
      }

      const emptyTileSrcDir = path.join(paths.templates, 'empty-tiles');
      fs.readdirSync(emptyTileSrcDir).forEach((tilefile) => {
        fs.linkSync(path.join(emptyTileSrcDir, tilefile),
          path.join(paths.emptyTiles, tilefile));
      });

      const mrfConfig = configGen.generateConfig(
        `EPSG:${event.transaction.epsg}`,
        event.transaction.date,
        event.transaction.zoom,
        this.config.mrfgen,
        paths
      );

      const destBucket = this.config.output.Bucket;
      const destKey = this.config.output.Key;

      log.info("Writing mrfgen config", mrfConfig);
      fs.writeFileSync(paths.mrfgenConfig, mrfConfig, {
        mode: 0o600
      });

      for (const file of (this.config.files || [])) {
        if (file.filename) {
          const name = file.filename || path.basename(file.Key);
          const fullpath = path.join(paths.input, name);
          fs.writeFileSync(fullpath, file.contents, { mode: 0o600 });
        }
        else {
          await aws.downloadS3Files([file], paths.input);
        }
      }

      const eventInfo = `(${event.payload.length} files from ${this.transactionKey})`;
      await aws.downloadS3Files(event.payload, paths.input);
      this.logStageComplete(`Source Download ${eventInfo}`);
      await this.runMrfgen(paths.mrfgenConfig);
      this.logStageComplete(`MRF Generation ${eventInfo}`);
      const fullPaths = fs.readdirSync(paths.output).map((f) => path.join(paths.output, f));
      // Upload under the destKey bucket, inserting an underscore before the file extension
      const destKeyFn = (filename) =>
        path.join(destKey, path.basename(filename).replace(/\.([^\.]*)$/, '_.$1'));
      await aws.uploadS3Files(fullPaths, destBucket, destKeyFn);
    }
    catch (e) {
      console.log(e);
    }
    finally {
      execSync(`rm -rf ${tempDir}`);
    }
  }

  runMrfgen(configPath) {
    return new Promise((resolve, reject) => {
      const mrfgen = spawn('mrfgen', ['-c', configPath], {
        stdio: 'inherit',
        shell: true
      });
      mrfgen.on('close', (code) => {
        if (code === 0) {
          resolve(configPath);
        }
        else {
          reject(`mrfgen exited with code ${code}`);
        }
      });
    });
  }

  static handler(...args) {
    return GenerateMrfTask.handle(...args);
  }
};

module.exports.delegate = 'ECS';

if (['stdin', 'stdin-ecs'].indexOf(process.argv[2]) !== -1) {
  if (process.argv[2] === 'stdin') {
    module.exports.delegate = null;
  }
  module.exports.handler({
    eventName: 'sync-completed',
    eventSource: 'stdin',
    functionName: process.argv[3],
    config: {
      mrfgen: {
        mrf_compression_type: "JPEG",
        source_epsg: "{meta.epsg}",
        mrf_merge: false,
        mrf_nocopy: true,
        overview_resampling: "average",
        resize_resampling: "average",
        parameter_name: "{meta.parameterName}"
      },
      output: {
        Bucket: "{resources.buckets.public}",
        Key: "EPSG{meta.epsg}/{meta.collection}/{meta.date.year}"
      }
    }
  }, {}, () => {});
}