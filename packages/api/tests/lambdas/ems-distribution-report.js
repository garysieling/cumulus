'use strict';

const fs = require('fs-extra');
const moment = require('moment');
const path = require('path');
const test = require('ava');
const { aws } = require('@cumulus/common');
const { testUtils: { randomString } } = require('@cumulus/common');
const { bucketsPrefixes, generateAndStoreDistributionReport } = require('../../lambdas/ems-distribution-report');
const models = require('../../models');
const { fakeCollectionFactory, fakeGranuleFactoryV2, fakeFileFactory } = require('../../lib/testUtils');

// MYD13Q1___006 is reported to EMS
const collections = [
  fakeCollectionFactory({
    name: 'MYD13Q1',
    version: '006'
  }),
  fakeCollectionFactory({
    name: 'MOD14A1',
    version: '006',
    reportToEms: false
  })];

function fakeGranules() {
  const granules = [
    fakeGranuleFactoryV2({ collectionId: 'MYD13Q1___006' }),
    fakeGranuleFactoryV2({ collectionId: 'MOD14A1___006' })
  ];

  granules[0].files = [
    fakeFileFactory({
      bucket: 'my-dist-bucket',
      key: 'my-dist-folder/data/MYD13Q1.A2017297.h19v10.006.2017313221229.hdf',
      type: 'data'
    }),
    fakeFileFactory({
      bucket: 'my-dist-bucket',
      key: 'my-dist-folder/data/MYD13Q1.A2017297.h19v10.006.2017313221229.hdf.cmr.xml',
      type: 'metadata'
    }),
    fakeFileFactory({
      bucket: 'my-public-dist-bucket',
      key: 'my-dist-folder/data/MYD13Q1.A2017297.h19v10.006.2017313221229.hdf.jpg'
    })
  ];

  granules[1].files = [
    fakeFileFactory({
      bucket: 'my-dist-bucket2',
      key: 'MOD14A1___006/MOD/MOD14A1.A2739327.duVbLT.006.3445346596432_ndvi.jpg',
      type: 'browse'
    }),
    fakeFileFactory({
      bucket: 'my-dist-bucket2',
      key: 'MOD14A1___006/2017/MOD/MOD14A1.A0511093.PzaAbP.006.7020516472140.hdf'
    })
  ];
  return granules;
}

let expectedReportContent;

test.before(async () => {
  process.env.system_bucket = randomString();
  process.env.stackName = randomString();
  process.env.ems_provider = 'testEmsProvider';

  process.env.CollectionsTable = randomString();
  process.env.GranulesTable = randomString();
  process.env.FilesTable = randomString();
});

test.beforeEach(async (t) => {
  t.context.internalBucket = process.env.system_bucket;
  const { logsBucket, logsPrefix } = bucketsPrefixes();

  await aws.s3().createBucket({ Bucket: t.context.internalBucket }).promise();

  const collectionModel = new models.Collection();
  const granuleModel = new models.Granule();
  const fileModel = new models.FileClass();

  await collectionModel.createTable();
  await collectionModel.create(collections);

  await granuleModel.createTable();
  await fileModel.createTable();

  const granules = fakeGranules();

  // MYD13Q1___006 granuleId
  const myd13GranId = granules[0].granuleId;

  // only MYD13Q1___006 should be reported
  expectedReportContent = [
    `01-JUN-81 01:01:13 AM|&|cbrown|&|192.0.2.3|&|s3://my-dist-bucket/my-dist-folder/data/MYD13Q1.A2017297.h19v10.006.2017313221229.hdf|&|807|&|S|&|MYD13Q1|&|006|&|${myd13GranId}|&|SCIENCE|&|HTTPS`,
    `01-JUN-81 01:02:13 AM|&|amalkin|&|192.0.2.3|&|s3://my-dist-bucket/my-dist-folder/data/MYD13Q1.A2017297.h19v10.006.2017313221229.hdf.cmr.xml|&|807|&|F|&|MYD13Q1|&|006|&|${myd13GranId}|&|METADATA|&|HTTPS`,
    `01-JUN-81 02:03:13 PM|&|-|&|192.0.2.3|&|s3://my-public-dist-bucket/my-dist-folder/data/MYD13Q1.A2017297.h19v10.006.2017313221229.hdf.jpg|&|807|&|S|&|MYD13Q1|&|006|&|${myd13GranId}|&|OTHER|&|HTTPS`
  ];

  await Promise.all(granules.map(async (granule) => {
    await granuleModel.create(granule);
    await fileModel.createFilesFromGranule(granule);
  }));

  // Read in all of the server logs from the fixtures files
  const fixturesDirectory = path.join(__dirname, 'fixtures', 'ems-distribution-report');
  const serverLogFilenames = await fs.readdir(fixturesDirectory);
  const serverLogs = await Promise.all(serverLogFilenames.map((serverFilename) =>
    fs.readFile(path.join(fixturesDirectory, serverFilename), 'utf8')));

  // Upload the S3 server logs to the internal bucket
  await Promise.all(serverLogs.map((serverLog) =>
    aws.s3().putObject({
      Bucket: logsBucket,
      Key: aws.s3Join([logsPrefix, `${randomString()}.log`]),
      Body: serverLog
    }).promise()));
});

test.afterEach.always(async (t) => {
  Promise.all([
    new models.FileClass().deleteTable(),
    new models.Granule().deleteTable(),
    new models.Collection().deleteTable()
  ]);
  await aws.recursivelyDeleteS3Bucket(t.context.internalBucket);
});

test.serial('emsDistributionReport writes a correct report out to S3 when no previous reports exist', async (t) => {
  const reportsBucket = t.context.internalBucket;

  const reportStartTime = moment.utc('1981-06-01T01:00:00Z');
  const reportEndTime = moment.utc('1981-06-01T15:00:00Z');

  // Generate the distribution report
  const report = await generateAndStoreDistributionReport({
    reportStartTime,
    reportEndTime
  });

  // Fetch the distribution report from S3
  const getObjectResponse = await aws.s3().getObject({
    Bucket: reportsBucket,
    Key: aws.parseS3Uri(report.file).Key
  }).promise();
  const logLines = getObjectResponse.Body.toString().split('\n');

  // Verify that the correct report was generated
  t.deepEqual(logLines, expectedReportContent);
});

test.serial('emsDistributionReport writes a correct report out to S3 when one report already exists', async (t) => {
  const reportStartTime = moment.utc('1981-06-01T01:00:00Z');
  const reportEndTime = moment.utc('1981-06-01T15:00:00Z');

  const reportName = `${reportStartTime.format('YYYYMMDD')}_${process.env.ems_provider}_DistCustom_${process.env.stackName}.flt`;

  const { reportsBucket, reportsPrefix } = bucketsPrefixes();
  await aws.s3().putObject({
    Bucket: reportsBucket,
    Key: aws.s3Join([reportsPrefix, reportName]),
    Body: 'my report'
  }).promise();

  // Generate the distribution report
  await generateAndStoreDistributionReport({
    reportStartTime,
    reportEndTime
  });

  // Fetch the distribution report from S3
  const getObjectResponse = await aws.s3().getObject({
    Bucket: reportsBucket,
    Key: aws.s3Join([reportsPrefix, `${reportName}.rev1`])
  }).promise();
  const logLines = getObjectResponse.Body.toString().split('\n');

  // Verify that the correct report was generated
  t.deepEqual(logLines, expectedReportContent);
});

test.serial('emsDistributionReport writes a correct report out to S3 when two reports already exist', async (t) => {
  const reportStartTime = moment.utc('1981-06-01T01:00:00Z');
  const reportEndTime = moment.utc('1981-06-01T15:00:00Z');

  const { reportsBucket, reportsPrefix } = bucketsPrefixes();

  const reportName = `${reportStartTime.format('YYYYMMDD')}_${process.env.ems_provider}_DistCustom_${process.env.stackName}.flt`;

  await Promise.all([
    aws.s3().putObject({
      Bucket: reportsBucket,
      Key: aws.s3Join([reportsPrefix, reportName]),
      Body: 'my report'
    }).promise(),
    aws.s3().putObject({
      Bucket: reportsBucket,
      Key: aws.s3Join([reportsPrefix, `${reportName}.rev1`]),
      Body: 'my report'
    }).promise()
  ]);

  // Generate the distribution report
  await generateAndStoreDistributionReport({
    reportStartTime,
    reportEndTime
  });

  // Fetch the distribution report from S3
  const getObjectResponse = await aws.s3().getObject({
    Bucket: reportsBucket,
    Key: aws.s3Join([reportsPrefix, `${reportName}.rev2`])
  }).promise();
  const logLines = getObjectResponse.Body.toString().split('\n');

  // Verify that the correct report was generated
  t.deepEqual(logLines, expectedReportContent);
});
