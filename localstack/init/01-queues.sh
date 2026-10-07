#!/bin/bash
# Runs inside LocalStack when it is ready (/etc/localstack/init/ready.d).
set -euo pipefail

DLQ_URL=$(awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false,MessageRetentionPeriod=1209600 --query QueueUrl --output text)
DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)

# maxReceiveCount is a broker-side safety net (app limit + 2): the consumer moves poison messages itself with a reason.
awslocal sqs create-queue --queue-name wager-transactions.fifo --attributes "{
  \"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"30\",
  \"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"7\\\"}\"
}"

awslocal sqs create-queue --queue-name wager-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false,MessageRetentionPeriod=1209600
echo "queues ready"
