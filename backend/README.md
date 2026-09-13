# Picks API — prepared, not deployed

The existing website still uses its current local storage/Sheets behavior.
`picks-api.mjs` is an adapter prepared for integration after deployment and sign-in.

## Deployment contract

- Lambda name: `SundayPickEm-Api`; region: `us-east-2`; Python handler: `handler.handler`.
- Execution role: `PickEm-ApiRuntime`, trusting only `lambda.amazonaws.com`.
- Attach `runtime-permissions.json` to that execution role. Deployment must create
  the `/aws/lambda/SundayPickEm-Api` log group before invoking the function.
- The function uses the boto3 SDK included in the AWS-managed Python 3.13 runtime.
- Require `USER_POOL_ISSUER` and `APP_CLIENT_ID` environment variables matching Cognito.
- API Gateway HTTP API routes: `GET /picks`, `PUT /picks/{eventId}`. Both must use
  a JWT authorizer with the expected issuer/client and an access-token scope.
- Lambda invoke permission must be limited to this API's execution ARN/account.
- Configure API Gateway CORS for `https://matthcoding.github.io`, methods GET/PUT,
  and headers Authorization/Content-Type. CORS does not provide authentication.
- Never deploy a public unauthenticated function URL.

The API obtains user identity from the authorizer and reads the current schedule,
spread, and kickoff from ESPN. Client-supplied identity, line, and kickoff values
are rejected. Missing odds fail closed. Stored picks remain readable after kickoff.
Users can change picks before kickoff; each accepted change stores the current line.
Picks use userId as partition key and `season#week#eventId` as sort key, with a
zero-padded two-digit week. Permission to read other users' picks is not exposed.

The existing GitHub deployment role cannot create IAM roles, Lambda functions,
Cognito pools, or HTTP APIs. Those permissions/resources must be arranged before
deployment. Its current database setup policy is not sufficient.
