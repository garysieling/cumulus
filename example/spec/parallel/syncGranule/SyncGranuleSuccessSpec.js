const fs = require('fs');
const path = require('path');
const {
  api: apiTestUtils,
  buildAndExecuteWorkflow,
  addProviders,
  cleanupProviders,
  addCollections,
  cleanupCollections,
  LambdaStep
} = require('@cumulus/integration-tests');
const { Collection, Execution } = require('@cumulus/api/models');
const {
  aws: {
    s3,
    s3GetObjectTagging,
    s3ObjectExists,
    parseS3Uri
  },
  constructCollectionId
} = require('@cumulus/common');
const {
  loadConfig,
  templateFile,
  uploadTestDataToBucket,
  createTimestampedTestId,
  createTestDataPath,
  createTestSuffix,
  deleteFolder
} = require('../../helpers/testUtils');
const {
  setupTestGranuleForIngest,
  loadFileWithUpdatedGranuleIdPathAndCollection
} = require('../../helpers/granuleUtils');
const config = loadConfig();
const lambdaStep = new LambdaStep();
const workflowName = 'SyncGranule';

const granuleRegex = '^MOD09GQ\\.A[\\d]{7}\\.[\\w]{6}\\.006\\.[\\d]{13}$';

const outputPayloadTemplateFilename = './spec/parallel/syncGranule/SyncGranule.output.payload.template.json';
const templatedOutputPayloadFilename = templateFile({
  inputTemplateFilename: outputPayloadTemplateFilename,
  config: config.SyncGranule
});

const s3data = [
  '@cumulus/test-data/granules/MOD09GQ.A2016358.h13v04.006.2016360104606.hdf.met',
  '@cumulus/test-data/granules/MOD09GQ.A2016358.h13v04.006.2016360104606.hdf'
];

describe('When the Sync Granules workflow is configured to overwrite data with duplicate filenames\n', () => {
  const testId = createTimestampedTestId(config.stackName, 'SyncGranuleSuccess');
  const testSuffix = createTestSuffix(testId);
  const testDataFolder = createTestDataPath(testId);

  const inputPayloadFilename = './spec/parallel/syncGranule/SyncGranule.input.payload.json';

  const providersDir = './data/providers/s3/';
  const collectionsDir = './data/collections/s3_MOD09GQ_006';
  const collection = { name: `MOD09GQ${testSuffix}`, version: '006' };
  const provider = { id: `s3_provider${testSuffix}` };
  const newCollectionId = constructCollectionId(collection.name, collection.version);

  let inputPayload;
  let expectedPayload;
  let expectedS3TagSet;
  let workflowExecution;

  process.env.ExecutionsTable = `${config.stackName}-ExecutionsTable`;
  const executionModel = new Execution();
  process.env.CollectionsTable = `${config.stackName}-CollectionsTable`;
  const collectionModel = new Collection();

  beforeAll(async () => {
    // populate collections, providers and test data
    await Promise.all([
      uploadTestDataToBucket(config.bucket, s3data, testDataFolder),
      addCollections(config.stackName, config.bucket, collectionsDir, testSuffix),
      addProviders(config.stackName, config.bucket, providersDir, config.bucket, testSuffix)
    ]);
    await collectionModel.update(collection, { duplicateHandling: 'replace' });

    const inputPayloadJson = fs.readFileSync(inputPayloadFilename, 'utf8');
    // update test data filepaths
    inputPayload = await setupTestGranuleForIngest(config.bucket, inputPayloadJson, granuleRegex, testSuffix, testDataFolder);
    const newGranuleId = inputPayload.granules[0].granuleId;
    expectedS3TagSet = [{ Key: 'granuleId', Value: newGranuleId }];
    await Promise.all(inputPayload.granules[0].files.map((fileToTag) =>
      s3().putObjectTagging({ Bucket: config.bucket, Key: `${fileToTag.path}/${fileToTag.name}`, Tagging: { TagSet: expectedS3TagSet } }).promise()));

    expectedPayload = loadFileWithUpdatedGranuleIdPathAndCollection(templatedOutputPayloadFilename, newGranuleId, testDataFolder, newCollectionId);
    expectedPayload.granules[0].dataType += testSuffix;

    workflowExecution = await buildAndExecuteWorkflow(
      config.stackName, config.bucket, workflowName, collection, provider, inputPayload
    );
  });

  afterAll(async () => {
    // clean up stack state added by test
    await Promise.all([
      deleteFolder(config.bucket, testDataFolder),
      cleanupCollections(config.stackName, config.bucket, collectionsDir, testSuffix),
      cleanupProviders(config.stackName, config.bucket, providersDir, testSuffix),
      apiTestUtils.deleteGranule({
        prefix: config.stackName,
        granuleId: inputPayload.granules[0].granuleId
      })
    ]);
  });

  it('completes execution with success status', () => {
    expect(workflowExecution.status).toEqual('SUCCEEDED');
  });

  describe('the SyncGranule Lambda function', () => {
    let lambdaOutput = null;
    let files;
    let key1;
    let key2;
    let syncedTaggings;
    let existCheck = [];

    beforeAll(async () => {
      lambdaOutput = await lambdaStep.getStepOutput(workflowExecution.executionArn, 'SyncGranule');
      files = lambdaOutput.payload.granules[0].files;
      key1 = path.join(files[0].fileStagingDir, files[0].name);
      key2 = path.join(files[1].fileStagingDir, files[1].name);

      existCheck = await Promise.all([
        s3ObjectExists({ Bucket: files[0].bucket, Key: key1 }),
        s3ObjectExists({ Bucket: files[1].bucket, Key: key2 })
      ]);
      syncedTaggings = await Promise.all(files.map((file) => {
        const { Bucket, Key } = parseS3Uri(file.filename);
        return s3GetObjectTagging(Bucket, Key);
      }));
    });

    it('receives payload with file objects updated to include file staging location', () => {
      expect(lambdaOutput.payload).toEqual(expectedPayload);
    });

    it('receives meta.input_granules with files objects updated to include file staging location', () => {
      expect(lambdaOutput.meta.input_granules).toEqual(expectedPayload.granules);
    });

    it('receives files with custom staging directory', () => {
      files.forEach((file) => {
        expect(file.fileStagingDir).toMatch('custom-staging-dir\/.*');
      });
    });

    it('adds files to staging location', () => {
      existCheck.forEach((check) => {
        expect(check).toEqual(true);
      });
    });

    it('preserves S3 tags on provider files', () => {
      syncedTaggings.forEach((tagging) => {
        expect(tagging.TagSet).toEqual(expectedS3TagSet);
      });
    });
  });

  describe('the sf-sns-report task has published a sns message and', () => {
    it('the execution record is added to DynamoDB', async () => {
      const record = await executionModel.get({ arn: workflowExecution.executionArn });
      expect(record.status).toEqual('completed');
    });
  });
});
