---
title: How-to guides
description: Goal-oriented recipes for embedding pgrest-lambda as a library, deploying it to AWS, and writing Cedar row-level policies.
---

# How-to guides

These guides assume you already have pgrest-lambda running locally (see the [Getting started tutorial](../tutorials/getting-started) if not). Each guide covers one specific goal end-to-end.

## Integrate

- **[How to use pgrest-lambda as a library](./use-as-a-library)** — Wire `createPgrest(config)` into your own server (Lambda, Fastify, Express, or any API-Gateway-event-shaped platform).

## Deploy

- **[How to deploy to AWS Lambda with SAM](./deploy-aws-sam)** — Deploy the reference AWS SAM template to get API Gateway + Lambda + (optionally) Cognito in one stack.

## Authorize

- **[How to write Cedar row-level policies](./write-cedar-policies)** — Add policy files under `policies/` to control who can read and write which rows.

## Looking something up?

If you want an exact option name, CLI flag, or error code, you probably want the [Reference section](../reference/) instead. If you want to understand *why* something is the way it is, see [Explanation](../explanation/).
