import assert from 'assert';
import fs from 'fs';
import path from 'path';
import * as core from '@actions/core';
import type { AssumeRoleCommandInput, STSClient, Tag } from '@aws-sdk/client-sts';
import { AssumeRoleCommand, AssumeRoleWithWebIdentityCommand } from '@aws-sdk/client-sts';
import type { CredentialsClient } from './CredentialsClient';
import { errorMessage, isDefined, sanitizeGithubActor, sanitizeGithubWorkflowName } from './helpers';

async function assumeRoleWithOIDC(params: AssumeRoleCommandInput, client: STSClient, webIdentityToken: string) {
  delete params.Tags;
  core.info('Assuming role with OIDC');
  try {
    return await client.send(
      new AssumeRoleWithWebIdentityCommand({
        ...params,
        WebIdentityToken: webIdentityToken,
      })
    );
  } catch (error) {
    throw new Error(`Could not assume role with OIDC: ${errorMessage(error)}`);
  }
}

async function assumeRoleWithWebIdentityTokenFile(
  params: AssumeRoleCommandInput,
  client: STSClient,
  webIdentityTokenFile: string,
  workspace: string
) {
  core.debug(
    'webIdentityTokenFile provided. Will call sts:AssumeRoleWithWebIdentity and take session tags from token contents.'
  );
  const webIdentityTokenFilePath = path.isAbsolute(webIdentityTokenFile)
    ? webIdentityTokenFile
    : path.join(workspace, webIdentityTokenFile);
  if (!fs.existsSync(webIdentityTokenFilePath)) {
    throw new Error(`Web identity token file does not exist: ${webIdentityTokenFilePath}`);
  }
  core.info('Assuming role with web identity token file');
  try {
    const webIdentityToken = fs.readFileSync(webIdentityTokenFilePath, 'utf8');
    delete params.Tags;
    return await client.send(
      new AssumeRoleWithWebIdentityCommand({
        ...params,
        WebIdentityToken: webIdentityToken,
      })
    );
  } catch (error) {
    throw new Error(`Could not assume role with web identity token file: ${errorMessage(error)}`);
  }
}

async function assumeRoleWithCredentials(params: AssumeRoleCommandInput, client: STSClient) {
  core.info('Assuming role with user credentials');
  try {
    return await client.send(new AssumeRoleCommand({ ...params }));
  } catch (error) {
    throw new Error(`Could not assume role with user credentials: ${errorMessage(error)}`);
  }
}

export interface assumeRoleParams {
  credentialsClient: CredentialsClient;
  roleToAssume: string;
  roleDuration: number;
  roleSessionName: string;
  roleSkipSessionTagging?: boolean;
  sourceAccountId?: string;
  roleExternalId?: string;
  webIdentityTokenFile?: string;
  webIdentityToken?: string;
}

export async function assumeRole(params: assumeRoleParams) {
  const {
    credentialsClient,
    sourceAccountId,
    roleToAssume,
    roleExternalId,
    roleDuration,
    roleSessionName,
    roleSkipSessionTagging,
    webIdentityTokenFile,
    webIdentityToken,
  } = { ...params };

  // Load GitHub environment variables
  const { GITHUB_REPOSITORY, GITHUB_WORKFLOW, GITHUB_ACTION, GITHUB_ACTOR, GITHUB_SHA, GITHUB_WORKSPACE } = process.env;
  if (!GITHUB_REPOSITORY || !GITHUB_WORKFLOW || !GITHUB_ACTION || !GITHUB_ACTOR || !GITHUB_SHA || !GITHUB_WORKSPACE) {
    throw new Error('Missing required environment variables. Are you running in GitHub Actions?');
  }

  // Load role session tags
  const tagArray: Tag[] = [
    { Key: 'GitHub', Value: 'Actions' },
    { Key: 'Repository', Value: GITHUB_REPOSITORY },
    { Key: 'Workflow', Value: sanitizeGithubWorkflowName(GITHUB_WORKFLOW) },
    { Key: 'Action', Value: GITHUB_ACTION },
    { Key: 'Actor', Value: sanitizeGithubActor(GITHUB_ACTOR) },
    { Key: 'Commit', Value: GITHUB_SHA },
  ];
  if (process.env['GITHUB_REF']) {
    tagArray.push({ Key: 'Branch', Value: process.env['GITHUB_REF'] });
  }
  const tags = roleSkipSessionTagging ? undefined : tagArray;
  if (!tags) {
    core.debug('Role session tagging has been skipped.');
  } else {
    core.debug(`${tags.length} role session tags are being used.`);
  }

  // Calculate role ARN from name and account ID (currently only supports `aws` partition)
  let roleArn = roleToAssume;
  if (!roleArn.startsWith('arn:aws')) {
    assert(
      isDefined(sourceAccountId),
      'Source Account ID is needed if the Role Name is provided and not the Role Arn.'
    );
    roleArn = `arn:aws:iam::${sourceAccountId}:role/${roleArn}`;
  }

  // Ready common parameters to assume role
  const commonAssumeRoleParams: AssumeRoleCommandInput = {
    RoleArn: roleArn,
    RoleSessionName: roleSessionName,
    DurationSeconds: roleDuration,
    Tags: tags ? tags : undefined,
    ExternalId: roleExternalId ? roleExternalId : undefined,
  };
  const keys = Object.keys(commonAssumeRoleParams) as Array<keyof typeof commonAssumeRoleParams>;
  keys.forEach((k) => commonAssumeRoleParams[k] === undefined && delete commonAssumeRoleParams[k]);

  // Instantiate STS client
  const stsClient = credentialsClient.getStsClient();

  // Assume role using one of three methods
  switch (true) {
    case !!webIdentityToken: {
      return assumeRoleWithOIDC(commonAssumeRoleParams, stsClient, webIdentityToken!);
    }

    case !!webIdentityTokenFile: {
      return assumeRoleWithWebIdentityTokenFile(
        commonAssumeRoleParams,
        stsClient,
        webIdentityTokenFile!,
        GITHUB_WORKSPACE
      );
    }

    default: {
      return assumeRoleWithCredentials(commonAssumeRoleParams, stsClient);
    }
  }
}