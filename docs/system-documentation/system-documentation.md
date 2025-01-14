---
id: system-documentation
title: Troubleshooting Cumulus
hide_title: true
---

# How to Troubleshoot and Fix Issues

While Cumulus is a complex system, there is a focus on maintaining the integrity and availability of the system and data. Should you encounter errors or issues while using this system, this section will help troubleshoot and solve those issues.

## Backup and Restore

Cumulus has backup and restore functionality built-in to protect Cumulus data and allow recovery of a Cumulus stack. This is currently limited to Cumulus data and not full S3 archive data. Backup and restore is not enabled by default and must be enabled and configured to take advantage of this feature.

For more information, read the [Backup and Restore documentation](data_in_dynamodb.md#backup-and-restore-with-aws).

## Elasticsearch reindexing

If new Elasticsearch mappings are added to Cumulus, they are automatically added to the index upon deploy. If you run into issues with your Elasticsearch index, a reindex operation is available via a command-line tool in the Cumulus API.

Information on how to reindex Elasticsearch is in the [Cumulus API package documentation](https://www.npmjs.com/package/@cumulus/api#reindexing-elasticsearch-indices).

## Troubleshooting Workflows

Workflows are state machines comprised of tasks and services and each component logs to [CloudWatch](https://aws.amazon.com/cloudwatch). The CloudWatch logs for all steps in the execution are displayed in the Cumulus dashboard or you can find them by going to CloudWatch and navigating to the logs for that particular task.

### Workflow Errors

Visual representations of executed workflows can be found in the Cumulus dashboard or the AWS Step Functions console for that particular execution.

If a workflow errors, the error will be handled according to the [error handling configuration](data-cookbooks/error-handling.md). The task that fails will have the `exception` field populated in the output, giving information about the error. Further information can be found in the CloudWatch logs for the task.

![Graph of AWS Step Function execution showing a failing workflow](assets/workflow-fail.png)

### Workflow Did Not Start

Generally, first check your rule configuration. If that is satisfactory, the answer will likely be in the CloudWatch logs for the schedule SF or SF starter lambda functions. See the [workflow triggers](workflows/workflow-triggers.md) page for more information on how workflows start.

For Kinesis rules specifically, if an error occurs during the message consumer process, the fallback consumer lambda will be called and if the message continues to error, a message will be placed on the dead letter queue. Check the dead letter queue for a failure message. Errors can be traced back to the CloudWatch logs for the message consumer and the fallback consumer.

More information on kinesis error handling is [here](data-cookbooks/cnm-workflow.md#kinesis-record-error-handling).

## Lambda Errors

### KMS Exception: AccessDeniedException

`KMS Exception: AccessDeniedExceptionKMS Message: The ciphertext refers to a customer master key that does not exist, does not exist in this region, or you are not allowed to access.`

The above error was being thrown by cumulus lambda function invocation. The KMS key is the encryption key used to encrypt lambda environment variables. The root cause of this error is unknown.

On a lambda level, this error can be resolved by updating the KMS Key to `aws/lambda`. We've done this through the management console. Unfortunately, this approach doesn't scale well.

The other resolution (that scales but takes some time) that was found is as follows:

1. Delete the whole `{{#each newsted_templates}}` section from `@cumulus/deployment/app/cloudformation.template.yml` and redeploy the primary stack.
2. Reinstall dependencies via `npm`.
3. Re-deploy the stack.

[Discussed in the Earthdata Wiki](https://wiki.earthdata.nasa.gov/display/CUMULUS/KMS+Exception%3A+AccessDeniedException).

### Error: Unable to import module 'index': Error

This error is shown in the CloudWatch logs for a Lambda function.

One possible cause is that the Lambda definition in `lambdas.yml` is not pointing to the directory for the `index.js` source file. In order to resolve this issue, update the lambda definition in `lambdas.yml` to point to the parent directory of the `index.js` file.

```yaml
DiscoverGranules:
  handler: index.handler
  timeout: 300
  source: 'node_modules/@cumulus/discover-granules/dist/'
  useMessageAdapter: true
```

If you are seeing this error when using the Lambda as a step in a Cumulus workflow, then inspect the output for this Lambda step in the AWS Step Function console. If you see the error `Cannot find module 'node_modules/@cumulus/cumulus-message-adapter-js'`, then you need to set `useMessageAdapter: true` in the Lambda definition in `lambdas.yml`.

[Discussed in the Earthdata Wiki](https://wiki.earthdata.nasa.gov/display/CUMULUS/Troubleshooting).
