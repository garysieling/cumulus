'use strict';

const cloneDeep = require('lodash.clonedeep');
const test = require('ava');
const sinon = require('sinon');

const aws = require('@cumulus/common/aws');
const ingestAws = require('@cumulus/ingest/aws');
const StepFunctions = require('@cumulus/common/StepFunctions');
const { randomString } = require('@cumulus/common/test-utils');
const cmrjs = require('@cumulus/cmrjs');
const { CMR } = require('@cumulus/cmrjs');
const { DefaultProvider } = require('@cumulus/common/key-pair-provider');

const range = require('lodash.range');

const { Granule } = require('../../models');
const { fakeFileFactory, fakeGranuleFactoryV2 } = require('../../lib/testUtils');

test.before(async () => {
  process.env.GranulesTable = randomString();
  await new Granule().createTable();
});

test.beforeEach((t) => {
  t.context.granuleModel = new Granule();

  t.context.cumulusMessage = {
    cumulus_meta: {
      execution_name: randomString(),
      state_machine: 'arn:aws:states:us-east-1:123456789012:stateMachine:HelloStateMachine',
      workflow_start_time: Date.now()
    },
    meta: {
      collection: {
        name: randomString(),
        version: randomString()
      },
      provider: {
        host: randomString(),
        protocol: 's3'
      },
      status: 'completed'
    },
    payload: {
      granules: [
        {
          granuleId: randomString(),
          sync_granule_duration: 123,
          post_to_cmr_duration: 456,
          files: []
        }
      ]
    }
  };
});

test.after.always(async () => {
  await new Granule().deleteTable();
  sinon.reset();
});

test('files existing at location returns empty array if no files exist', async (t) => {
  const filenames = [
    'granule-file-1.hdf',
    'granule-file-2.hdf'
  ];

  const sourceBucket = 'test-bucket';
  const destBucket = 'dest-bucket';

  const sourceFiles = filenames.map(
    (name) =>
      fakeFileFactory({
        name,
        bucket: sourceBucket,
        key: `origin/${name}`
      })
  );

  const destinationFilepath = 'destination';

  const destinations = [
    {
      regex: '.*.hdf$',
      bucket: destBucket,
      key: destinationFilepath
    }
  ];

  const granule = {
    files: sourceFiles
  };

  const granulesModel = new Granule();

  const filesExisting = await granulesModel.getFilesExistingAtLocation(granule, destinations);

  t.deepEqual(filesExisting, []);
});

test('files existing at location returns both files if both exist', async (t) => {
  const filenames = [
    'granule-file-1.hdf',
    'granule-file-2.hdf'
  ];

  const sourceBucket = 'test-bucket';
  const destBucket = randomString();

  await aws.s3().createBucket({ Bucket: destBucket }).promise();

  const sourceFiles = filenames.map(
    (fileName) => fakeFileFactory({ fileName, bucket: sourceBucket })
  );

  const destinations = [
    {
      regex: '.*.hdf$',
      bucket: destBucket
    }
  ];

  const dataSetupPromises = filenames.map(async (filename) => {
    const params = {
      Bucket: destBucket,
      Key: filename,
      Body: 'test'
    };
    return aws.s3().putObject(params).promise();
  });

  await Promise.all(dataSetupPromises);

  const granule = {
    files: sourceFiles
  };

  const granulesModel = new Granule();

  const filesExisting = await granulesModel.getFilesExistingAtLocation(granule, destinations);

  t.deepEqual(filesExisting, sourceFiles);

  await aws.recursivelyDeleteS3Bucket(destBucket);
});

test('files existing at location returns only file that exists', async (t) => {
  const filenames = [
    'granule-file-1.hdf',
    'granule-file-2.hdf'
  ];

  const sourceBucket = 'test-bucket';
  const destBucket = randomString();

  await aws.s3().createBucket({ Bucket: destBucket }).promise();

  const sourceFiles = filenames.map(
    (fileName) => fakeFileFactory({ fileName, bucket: sourceBucket })
  );

  const destinations = [
    {
      regex: '.*.hdf$',
      bucket: destBucket,
      filepath: ''
    }
  ];

  const params = {
    Bucket: destBucket,
    Key: filenames[1],
    Body: 'test'
  };
  await aws.s3().putObject(params).promise();

  const granule = {
    files: sourceFiles
  };

  const granulesModel = new Granule();

  const filesExisting = await granulesModel.getFilesExistingAtLocation(granule, destinations);

  t.deepEqual(filesExisting, [sourceFiles[1]]);

  await aws.recursivelyDeleteS3Bucket(destBucket);
});

test('files existing at location returns only file that exists with multiple destinations', async (t) => {
  const filenames = [
    'granule-file-1.txt',
    'granule-file-2.hdf'
  ];

  const sourceBucket = 'test-bucket';
  const destBucket1 = randomString();
  const destBucket2 = randomString();

  await Promise.all([
    aws.s3().createBucket({ Bucket: destBucket1 }).promise(),
    aws.s3().createBucket({ Bucket: destBucket2 }).promise()
  ]);

  const sourceFiles = filenames.map(
    (fileName) => fakeFileFactory({ fileName, bucket: sourceBucket })
  );

  const destinations = [
    {
      regex: '.*.txt$',
      bucket: destBucket1,
      filepath: ''
    },
    {
      regex: '.*.hdf$',
      bucket: destBucket2,
      filepath: ''
    }
  ];

  let params = {
    Bucket: destBucket1,
    Key: filenames[0],
    Body: 'test'
  };
  await aws.s3().putObject(params).promise();

  params = {
    Bucket: destBucket2,
    Key: filenames[1],
    Body: 'test'
  };
  await aws.s3().putObject(params).promise();

  const granule = {
    files: sourceFiles
  };

  const granulesModel = new Granule();

  const filesExisting = await granulesModel.getFilesExistingAtLocation(granule, destinations);

  t.deepEqual(filesExisting, sourceFiles);

  await Promise.all([
    aws.recursivelyDeleteS3Bucket(destBucket1),
    aws.recursivelyDeleteS3Bucket(destBucket2)
  ]);
});

test('get() will translate an old-style granule file into the new schema', async (t) => {
  const oldFile = {
    bucket: 'my-bucket',
    filename: 's3://my-bucket/path/to/file.txt',
    filepath: 'path/to/file.txt',
    name: 'file123.txt',
    path: 'source/path',
    checksumType: 'my-checksumType',
    checksumValue: 'my-checksumValue',
    url_path: 'some-url-path',
    fileSize: 1234
  };

  const granule = fakeGranuleFactoryV2({ files: [oldFile] });

  await aws.dynamodbDocClient().put({
    TableName: process.env.GranulesTable,
    Item: granule
  }).promise();

  const granuleModel = new Granule();
  const fetchedGranule = await granuleModel.get({ granuleId: granule.granuleId });

  t.deepEqual(
    fetchedGranule.files[0],
    {
      bucket: 'my-bucket',
      key: 'path/to/file.txt',
      fileName: 'file123.txt',
      checksumType: 'my-checksumType',
      checksum: 'my-checksumValue',
      size: 1234
    }
  );
});

test('get() will correctly return a granule file stored using the new schema', async (t) => {
  const newFile = {
    bucket: 'my-bucket',
    key: 'path/to/file.txt',
    fileName: 'file123.txt',
    checksumType: 'my-checksumType',
    checksum: 'my-checksumValue',
    size: 1234
  };

  const granule = fakeGranuleFactoryV2({ files: [newFile] });

  await aws.dynamodbDocClient().put({
    TableName: process.env.GranulesTable,
    Item: granule
  }).promise();

  const granuleModel = new Granule();
  const fetchedGranule = await granuleModel.get({ granuleId: granule.granuleId });

  t.deepEqual(
    fetchedGranule.files[0],
    {
      bucket: 'my-bucket',
      key: 'path/to/file.txt',
      fileName: 'file123.txt',
      checksumType: 'my-checksumType',
      checksum: 'my-checksumValue',
      size: 1234
    }
  );
});

test('batchGet() will translate old-style granule files into the new schema', async (t) => {
  const oldFile = {
    bucket: 'my-bucket',
    filename: 's3://my-bucket/path/to/file.txt',
    filepath: 'path/to/file.txt',
    name: 'file123.txt',
    path: 'source/path',
    checksumType: 'my-checksumType',
    checksumValue: 'my-checksumValue',
    url_path: 'some-url-path',
    fileSize: 1234
  };

  const granule = fakeGranuleFactoryV2({ files: [oldFile] });

  await aws.dynamodbDocClient().put({
    TableName: process.env.GranulesTable,
    Item: granule
  }).promise();

  const granuleModel = new Granule();
  const batchGetResponse = await granuleModel.batchGet([
    { granuleId: granule.granuleId }
  ]);

  const fetchedGranule = batchGetResponse.Responses[process.env.GranulesTable][0];

  t.deepEqual(
    fetchedGranule.files[0],
    {
      bucket: 'my-bucket',
      key: 'path/to/file.txt',
      fileName: 'file123.txt',
      checksumType: 'my-checksumType',
      checksum: 'my-checksumValue',
      size: 1234
    }
  );
});

test('scan() will translate old-style granule files into the new schema', async (t) => {
  const oldFile = {
    bucket: 'my-bucket',
    filename: 's3://my-bucket/path/to/file.txt',
    filepath: 'path/to/file.txt',
    name: 'file123.txt',
    path: 'source/path',
    checksumType: 'my-checksumType',
    checksumValue: 'my-checksumValue',
    url_path: 'some-url-path',
    fileSize: 1234
  };

  const granule = fakeGranuleFactoryV2({ files: [oldFile] });

  await aws.dynamodbDocClient().put({
    TableName: process.env.GranulesTable,
    Item: granule
  }).promise();

  const granuleModel = new Granule();
  const scanResponse = await granuleModel.scan({
    names: { '#granuleId': 'granuleId' },
    filter: '#granuleId = :granuleId',
    values: { ':granuleId': granule.granuleId }
  });

  t.deepEqual(
    scanResponse.Items[0].files[0],
    {
      bucket: 'my-bucket',
      key: 'path/to/file.txt',
      fileName: 'file123.txt',
      checksumType: 'my-checksumType',
      checksum: 'my-checksumValue',
      size: 1234
    }
  );
});

test('getGranulesForCollection returns the queue of granules', async (t) => {
  // create granules with different collectionIds and statuses
  const collectionIds = ['testGetGranulesForCollection___v1', 'testGetGranulesForCollection___v2'];
  const granulesV1 = range(5).map(() =>
    fakeGranuleFactoryV2({ collectionId: collectionIds[0], status: 'completed' }));
  const granulesV1Failed = range(5).map(() =>
    fakeGranuleFactoryV2({ collectionId: collectionIds[0], status: 'failed' }));
  const granulesV2 = range(5).map(() =>
    fakeGranuleFactoryV2({ collectionId: collectionIds[1], status: 'completed' }));

  const granule = new Granule();
  await granule.create(granulesV1.concat(granulesV1Failed).concat(granulesV2));

  // verify the granules retrieved meet the criteria and are in the correct order

  // get all completed v1 granules
  const queueV1Completed = granule.getGranulesForCollection(collectionIds[0], 'completed');
  const sortedV1CompletedGranIds = granulesV1.map((gran) => gran.granuleId).sort();
  for (let i = 0; i < 5; i += 1) {
    const gran = await queueV1Completed.peek(); // eslint-disable-line no-await-in-loop
    t.is(gran.granuleId, sortedV1CompletedGranIds[i]);
    t.is(gran.collectionId, collectionIds[0]);
    queueV1Completed.shift();
  }

  t.is(await queueV1Completed.peek(), null);

  // get all the v1 granules
  const queueV1Grans = granule.getGranulesForCollection(collectionIds[0]);
  const sortedV1GranuleIds = granulesV1.concat(granulesV1Failed)
    .map((gran) => gran.granuleId).sort();

  for (let i = 0; i < 10; i += 1) {
    const gran = await queueV1Grans.peek(); // eslint-disable-line no-await-in-loop
    t.is(gran.granuleId, sortedV1GranuleIds[i]);
    t.is(gran.collectionId, collectionIds[0]);
    queueV1Grans.shift();
  }

  t.is(await queueV1Grans.peek(), null);
});

test('removing a granule from CMR fails if the granule is not in CMR', async (t) => {
  const granule = fakeGranuleFactoryV2({ published: false });

  await aws.dynamodbDocClient().put({
    TableName: process.env.GranulesTable,
    Item: granule
  }).promise();

  const granuleModel = new Granule();

  try {
    await granuleModel.removeGranuleFromCmrByGranule(granule);
  } catch (err) {
    t.is(err.message, `Granule ${granule.granuleId} is not published to CMR, so cannot be removed from CMR`);
  }
});

test.serial('removing a granule from CMR passes the granule UR to the cmr delete function', async (t) => {
  sinon.stub(
    DefaultProvider,
    'decrypt'
  ).callsFake(() => Promise.resolve('fakePassword'));

  sinon.stub(
    CMR.prototype,
    'deleteGranule'
  ).callsFake((granuleUr) => Promise.resolve(t.is(granuleUr, 'granule-ur')));

  sinon.stub(
    cmrjs,
    'getMetadata'
  ).callsFake(() => Promise.resolve({ title: 'granule-ur' }));

  const granule = fakeGranuleFactoryV2();

  await aws.dynamodbDocClient().put({
    TableName: process.env.GranulesTable,
    Item: granule
  }).promise();

  const granuleModel = new Granule();

  await granuleModel.removeGranuleFromCmrByGranule(granule);

  CMR.prototype.deleteGranule.restore();
  DefaultProvider.decrypt.restore();
  cmrjs.getMetadata.restore();
});

test.serial('legacy remove granule from CMR fetches the granule and succeeds', async (t) => {
  sinon.stub(
    DefaultProvider,
    'decrypt'
  ).callsFake(() => Promise.resolve('fakePassword'));

  sinon.stub(
    CMR.prototype,
    'deleteGranule'
  ).callsFake((granuleUr) => Promise.resolve(t.is(granuleUr, 'granule-ur')));

  sinon.stub(
    cmrjs,
    'getMetadata'
  ).callsFake(() => Promise.resolve({ title: 'granule-ur' }));

  const granule = fakeGranuleFactoryV2();

  await aws.dynamodbDocClient().put({
    TableName: process.env.GranulesTable,
    Item: granule
  }).promise();

  const granuleModel = new Granule();

  await granuleModel.removeGranuleFromCmr(granule.granuleId, granule.collectionId);

  CMR.prototype.deleteGranule.restore();
  DefaultProvider.decrypt.restore();
  cmrjs.getMetadata.restore();
});

test(
  'createGranulesFromSns() properly sets timeToPreprocess when sync_granule_duration is present for a granule',
  async (t) => {
    const { granuleModel } = t.context;

    const cumulusMessage = cloneDeep(t.context.cumulusMessage);
    cumulusMessage.payload.granules[0].sync_granule_duration = 123;

    const result = await granuleModel.createGranulesFromSns(cumulusMessage);

    t.is(result.length, 1);

    t.is(result[0].timeToPreprocess, 0.123);
  }
);

test(
  'createGranulesFromSns() properly sets timeToPreprocess when sync_granule_duration is not present for a granule',
  async (t) => {
    const { granuleModel } = t.context;

    const cumulusMessage = cloneDeep(t.context.cumulusMessage);
    cumulusMessage.payload.granules[0].sync_granule_duration = 0;

    const result = await granuleModel.createGranulesFromSns(cumulusMessage);

    t.is(result.length, 1);

    t.is(result[0].timeToPreprocess, 0);
  }
);


test(
  'createGranulesFromSns() properly sets timeToArchive when post_to_cmr_duration is present for a granule',
  async (t) => {
    const { granuleModel } = t.context;

    const cumulusMessage = cloneDeep(t.context.cumulusMessage);
    cumulusMessage.payload.granules[0].post_to_cmr_duration = 123;

    const result = await granuleModel.createGranulesFromSns(cumulusMessage);

    t.is(result.length, 1);

    t.is(result[0].timeToArchive, 0.123);
  }
);

test.serial(
  'createGranulesFromSns() properly sets timeToArchive when post_to_cmr_duration is not present for a granule',
  async (t) => {
    const { granuleModel } = t.context;

    const cumulusMessage = cloneDeep(t.context.cumulusMessage);
    cumulusMessage.payload.granules[0].post_to_cmr_duration = 0;

    const result = await granuleModel.createGranulesFromSns(cumulusMessage);

    t.is(result.length, 1);

    t.is(result[0].timeToArchive, 0);
  }
);

test(
  'createGranulesFromSns() properly sets processingStartDateTime when sync_granule_end_time is present for a granule',
  async (t) => {
    const { granuleModel } = t.context;

    const cumulusMessage = cloneDeep(t.context.cumulusMessage);
    cumulusMessage.payload.granules[0].sync_granule_end_time = 100000;

    const result = await granuleModel.createGranulesFromSns(cumulusMessage);

    t.is(result.length, 1);
    t.is(result[0].processingStartDateTime, '1970-01-01T00:01:40.000Z');
  }
);

test(
  'createGranulesFromSns() does not set processingStartDateTime when sync_granule_end_time is not present for a granule',
  async (t) => {
    const { granuleModel } = t.context;

    const cumulusMessage = cloneDeep(t.context.cumulusMessage);
    delete cumulusMessage.payload.granules[0].sync_granule_end_time;

    const result = await granuleModel.createGranulesFromSns(cumulusMessage);

    t.is(result.length, 1);
    t.false(Object.keys(result[0]).includes('processingStartDateTime'));
  }
);

test(
  'createGranulesFromSns() properly sets processingEndDateTime when sync_granule_end_time is present for a granule',
  async (t) => {
    const { granuleModel } = t.context;

    const cumulusMessage = cloneDeep(t.context.cumulusMessage);
    cumulusMessage.payload.granules[0].post_to_cmr_start_time = 100000;

    const result = await granuleModel.createGranulesFromSns(cumulusMessage);

    t.is(result.length, 1);
    t.is(result[0].processingEndDateTime, '1970-01-01T00:01:40.000Z');
  }
);

test(
  'createGranulesFromSns() does not set processingEndDateTime when post_to_cmr_start_time is not present for a granule',
  async (t) => {
    const { granuleModel } = t.context;

    const cumulusMessage = cloneDeep(t.context.cumulusMessage);
    delete cumulusMessage.payload.granules[0].post_to_cmr_start_time;

    const result = await granuleModel.createGranulesFromSns(cumulusMessage);

    t.is(result.length, 1);
    t.false(Object.keys(result[0]).includes('processingEndDateTime'));
  }
);

test(
  'createGranulesFromSns() ignores granules without a granuleId set',
  async (t) => {
    const { granuleModel } = t.context;

    const cumulusMessage = cloneDeep(t.context.cumulusMessage);
    cumulusMessage.payload.granules.push({});

    const result = await granuleModel.createGranulesFromSns(cumulusMessage);

    t.is(result.length, 1);
    t.is(result[0].granuleId, cumulusMessage.payload.granules[0].granuleId);
  }
);

test(
  'createGranulesFromSns() returns null if no granules are present in the cumulus message',
  async (t) => {
    const { granuleModel } = t.context;

    const cumulusMessage = cloneDeep(t.context.cumulusMessage);
    delete cumulusMessage.payload.granules;
    delete cumulusMessage.meta.input_granules;

    const result = await granuleModel.createGranulesFromSns(cumulusMessage);

    t.is(result, null);
  }
);

test(
  'createGranulesFromSns() returns null if cumulus_meta.execution_name is not set',
  async (t) => {
    const { granuleModel } = t.context;

    const cumulusMessage = cloneDeep(t.context.cumulusMessage);
    delete cumulusMessage.cumulus_meta.execution_name;

    t.is(await granuleModel.createGranulesFromSns(cumulusMessage), null);
  }
);

test(
  'createGranulesFromSns() returns null if cumulus_meta.state_machine is not set',
  async (t) => {
    const { granuleModel } = t.context;

    const cumulusMessage = cloneDeep(t.context.cumulusMessage);
    delete cumulusMessage.cumulus_meta.state_machine;

    t.is(await granuleModel.createGranulesFromSns(cumulusMessage), null);
  }
);

test.serial(
  'reingest pushes a message with the correct queueName',
  async (t) => {
    const { granuleModel } = t.context;
    const updateStatusStub = sinon.stub(granuleModel, "updateStatus");
    const queueName = 'testQueueName';
    const granule = {
      execution: 'some/execution',
      collectionId: 'MyCollection___006',
      provider: 'someProvider',
      queueName
    };
    const fileExists = async () => true;
    const fileExistsStub = sinon.stub(aws, 'fileExists').callsFake(fileExists);
    const invokeStub = sinon.stub(ingestAws, 'invoke');

    const cumulusMessage = cloneDeep(t.context.cumulusMessage);
    const fakeExecution = async () => ({ input: JSON.stringify(cumulusMessage) });
    const stepFunctionsStub = sinon.stub(StepFunctions, 'describeExecution').callsFake(fakeExecution);

    try {
      await granuleModel.reingest(granule);
      const invokeArgs = invokeStub.args[0];
      const invokeLambdaPayload = invokeArgs[1];
      t.is(invokeLambdaPayload.queueName, queueName);
    } finally {
      fileExistsStub.restore();
      invokeStub.restore();
      stepFunctionsStub.restore();
      updateStatusStub.restore();
    }
  }
)
