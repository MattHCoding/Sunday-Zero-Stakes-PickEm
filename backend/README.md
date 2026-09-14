# Picks API

The protected API and Cognito account service are deployed in us-east-2.
Public application identifiers are in `aws-config.mjs`.
`createAppPicksApi(getAccessToken)` configures the authenticated adapter.

The website saves picks on the device only. Google Sheets submission has been
removed. Sign-in and authenticated frontend save/load integration remain pending.
No accounts have been created; authenticated end-to-end saving is not yet tested.
Existing device picks are preserved and are not automatically uploaded.

CloudShell setup verified that unauthenticated GET and PUT requests return 401.
Both routes require Cognito access tokens. Lambda derives the user from the JWT
authorizer and verifies the issuer and client. DynamoDB picks are scoped by user.
The server obtains current lines and kickoff times from ESPN and rejects late
picks, missing lines, and client-supplied identity or spread values.

GitHub Actions deploys SundayPickEm-Api through the PickEm-GitHub-Deploy role.
Its IAM permissions allow passing only PickEm-ApiRuntime. Cognito and HTTP API
resources were created through the CloudShell bootstrap script.
No long-lived AWS keys are stored in the website.
