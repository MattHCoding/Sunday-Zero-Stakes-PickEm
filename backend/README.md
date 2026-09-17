# Sign-in and cloud picks — prepared for activation

The `activate-cloud-sign-in` branch implements Cognito hosted sign-in with
OAuth authorization code + PKCE, state validation and a ten-minute transaction
lifetime. Tokens stay in memory and expire after one hour. Reloading requires
sign-in again; Cognito can reuse its login session. Passwords are entered only
on the AWS-hosted page. No AWS credentials are shipped to browsers.

Signed-in picks load from the protected API and save only after server confirmation.
Guest device picks remain separate and are never automatically uploaded. Save
failures require a refresh before another attempt, resolving ambiguous network
outcomes. Signed-in picks are not cached in local storage.

## Remaining activation steps

1. Run `python3 backend/enable-sign-in.py` in AWS CloudShell in account
   442426890475. This adds the hosted sign-in domain to the existing pool without
   changing picks or sending invitations. GitHub's deployment role does not have
   Cognito administration permissions.
2. Create the owner's account in Cognito pool `us-east-2_AstbKn1rW` using the
   AWS console. Choose the owner's email and deliver the temporary password
   privately. Do not post credentials in GitHub or chat. No account exists yet.
3. Verify that the hosted sign-in page is available, then merge this branch to main.
4. Sign in, change the temporary password, save an upcoming-game pick, then sign
   in from another browser and confirm it loads. This authenticated end-to-end
   check remains pending until the domain and account exist.

The API and database were already deployed in us-east-2. Both GET and PUT require
Cognito access tokens; unauthenticated calls returned 401 in the bootstrap check.
API Gateway verifies JWTs and Lambda validates issuer/client/token type. The
server derives user identity, kickoff and current spread; it rejects late picks
and unavailable odds. Existing deployment permissions are unchanged.
