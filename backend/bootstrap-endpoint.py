"""Run in CloudShell: create a JWT-protected API and invite-only Cognito pool."""
import json
import subprocess
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ACCOUNT = "442426890475"
REGION = "us-east-2"
STACK = "SundayPickEm-WebApi"
FUNCTION = "SundayPickEm-Api"
FUNCTION_ARN = f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:{FUNCTION}"
SITE = "https://matthcoding.github.io/Sunday-Zero-Stakes-PickEm/"


def ref(name):
    return {"Ref": name}


def sub(value):
    return {"Fn::Sub": value}


def aws(service, operation, *, missing_ok=False, **parameters):
    args = ["aws", service, operation, "--region", REGION, "--output", "json", "--no-cli-pager"]
    for key, value in parameters.items():
        args.extend(["--" + key.replace("_", "-"), json.dumps(value) if isinstance(value, (dict, list)) else str(value)])
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode:
        if missing_ok and "does not exist" in result.stderr and "ValidationError" in result.stderr:
            return None
        raise RuntimeError(result.stderr.strip())
    return json.loads(result.stdout) if result.stdout.strip() else {}


TEMPLATE = {
    "AWSTemplateFormatVersion": "2010-09-09",
    "Description": "Protected HTTP endpoint and invite-only accounts for Sunday PickEm. No IAM roles created.",
    "Resources": {
        "UserPool": {
            "Type": "AWS::Cognito::UserPool", "DeletionPolicy": "Retain", "UpdateReplacePolicy": "Retain",
            "Properties": {
                "UserPoolName": "SundayPickEm-Users", "UsernameAttributes": ["email"],
                "AutoVerifiedAttributes": ["email"], "UsernameConfiguration": {"CaseSensitive": False},
                "AdminCreateUserConfig": {"AllowAdminCreateUserOnly": True},
                "Policies": {"PasswordPolicy": {"MinimumLength": 12, "RequireLowercase": True,
                    "RequireUppercase": True, "RequireNumbers": True, "RequireSymbols": True}},
            },
        },
        "AppClient": {
            "Type": "AWS::Cognito::UserPoolClient",
            "Properties": {
                "UserPoolId": ref("UserPool"), "ClientName": "SundayPickEm-Web",
                "GenerateSecret": False, "PreventUserExistenceErrors": "ENABLED",
                "EnableTokenRevocation": True,
                "ExplicitAuthFlows": ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
                "AllowedOAuthFlowsUserPoolClient": True, "AllowedOAuthFlows": ["code"],
                "AllowedOAuthScopes": ["openid", "email", "profile", "aws.cognito.signin.user.admin"],
                "SupportedIdentityProviders": ["COGNITO"], "CallbackURLs": [SITE], "LogoutURLs": [SITE],
                "AccessTokenValidity": 1, "IdTokenValidity": 1, "RefreshTokenValidity": 7,
            },
        },
        "Api": {
            "Type": "AWS::ApiGatewayV2::Api",
            "Properties": {
                "Name": "SundayPickEm-WebApi", "ProtocolType": "HTTP",
                "CorsConfiguration": {"AllowOrigins": ["https://matthcoding.github.io"],
                    "AllowMethods": ["GET", "PUT", "OPTIONS"], "AllowHeaders": ["authorization", "content-type"], "MaxAge": 300},
            },
        },
        "Authorizer": {
            "Type": "AWS::ApiGatewayV2::Authorizer",
            "Properties": {
                "Name": "PickEmAccounts", "ApiId": ref("Api"), "AuthorizerType": "JWT",
                "IdentitySource": ["$request.header.Authorization"],
                "JwtConfiguration": {"Audience": [ref("AppClient")],
                    "Issuer": sub("https://cognito-idp.us-east-2.amazonaws.com/${UserPool}")},
            },
        },
        "Integration": {
            "Type": "AWS::ApiGatewayV2::Integration",
            "Properties": {"ApiId": ref("Api"), "IntegrationType": "AWS_PROXY",
                "IntegrationUri": FUNCTION_ARN, "PayloadFormatVersion": "2.0", "TimeoutInMillis": 12000},
        },
        "InvokePermission": {
            "Type": "AWS::Lambda::Permission",
            "Properties": {"FunctionName": FUNCTION_ARN, "Action": "lambda:InvokeFunction",
                "Principal": "apigateway.amazonaws.com", "SourceAccount": ACCOUNT,
                "SourceArn": sub("arn:aws:execute-api:us-east-2:442426890475:${Api}/*/*/picks*")},
        },
        "Stage": {
            "Type": "AWS::ApiGatewayV2::Stage", "DependsOn": ["ReadPicks", "SavePick"],
            "Properties": {"ApiId": ref("Api"), "StageName": "$default", "AutoDeploy": True,
                "DefaultRouteSettings": {"ThrottlingBurstLimit": 10, "ThrottlingRateLimit": 5}},
        },
    },
    "Outputs": {
        "ApiUrl": {"Value": {"Fn::GetAtt": ["Api", "ApiEndpoint"]}},
        "UserPoolId": {"Value": ref("UserPool")},
        "UserPoolIssuer": {"Value": sub("https://cognito-idp.us-east-2.amazonaws.com/${UserPool}")},
        "AppClientId": {"Value": ref("AppClient")},
    },
}
for name, route in [("ReadPicks", "GET /picks"), ("SavePick", "PUT /picks/{eventId}")]:
    TEMPLATE["Resources"][name] = {"Type": "AWS::ApiGatewayV2::Route", "Properties": {
        "ApiId": ref("Api"), "RouteKey": route, "Target": sub("integrations/${Integration}"),
        "AuthorizationType": "JWT", "AuthorizerId": ref("Authorizer"),
        "AuthorizationScopes": ["aws.cognito.signin.user.admin"],
    }}


def main():
    if aws("sts", "get-caller-identity")["Account"] != ACCOUNT:
        raise RuntimeError("Wrong AWS account. No changes made.")
    function = aws("lambda", "get-function-configuration", function_name=FUNCTION)
    if function["Role"] != f"arn:aws:iam::{ACCOUNT}:role/PickEm-ApiRuntime" or function["State"] != "Active":
        raise RuntimeError("Expected API function is not ready.")
    existing = aws("cloudformation", "describe-stacks", stack_name=STACK, missing_ok=True)
    if existing is None:
        aws("cloudformation", "validate-template", template_body=TEMPLATE)
        aws("cloudformation", "create-stack", stack_name=STACK, template_body=TEMPLATE, on_failure="DO_NOTHING")
        print("Creating the protected endpoint and account service. This may take a few minutes.", flush=True)
    else:
        old = aws("cloudformation", "get-template", stack_name=STACK)["TemplateBody"]
        if isinstance(old, str):
            old = json.loads(old)
        if old != TEMPLATE:
            raise RuntimeError("Existing stack has a different template. It was not changed.")
        if existing["Stacks"][0]["StackStatus"] not in ("CREATE_IN_PROGRESS", "CREATE_COMPLETE"):
            raise RuntimeError("Stack needs review in CloudFormation: " + existing["Stacks"][0]["StackStatus"])
    result = subprocess.run(["aws", "cloudformation", "wait", "stack-create-complete",
        "--stack-name", STACK, "--region", REGION], timeout=900)
    if result.returncode:
        events = aws("cloudformation", "describe-stack-events", stack_name=STACK)["StackEvents"]
        failures = [e.get("LogicalResourceId", "") + ": " + e.get("ResourceStatusReason", "")
                    for e in events if e.get("ResourceStatus") == "CREATE_FAILED"]
        raise RuntimeError("; ".join(failures) or "Stack creation needs review.")
    outputs = {item["OutputKey"]: item["OutputValue"] for item in
               aws("cloudformation", "describe-stacks", stack_name=STACK)["Stacks"][0]["Outputs"]}
    function = aws("lambda", "get-function-configuration", function_name=FUNCTION)
    variables = function.get("Environment", {}).get("Variables", {})
    variables.update(USER_POOL_ISSUER=outputs["UserPoolIssuer"], APP_CLIENT_ID=outputs["AppClientId"])
    aws("lambda", "update-function-configuration", function_name=FUNCTION,
        environment={"Variables": variables}, revision_id=function["RevisionId"])
    subprocess.run(["aws", "lambda", "wait", "function-updated-v2", "--function-name", FUNCTION,
        "--region", REGION], check=True, timeout=240)
    for method, path in [("GET", "/picks?seasonYear=2026&weekNumber=1"), ("PUT", "/picks/0")]:
        try:
            with urlopen(Request(outputs["ApiUrl"] + path, method=method,
                data=b"{}" if method == "PUT" else None), timeout=20):
                raise RuntimeError("Endpoint unexpectedly accepted an unauthenticated request.")
        except HTTPError as error:
            if error.code != 401:
                raise RuntimeError("Unexpected endpoint status: " + str(error.code))
    print("SUCCESS: Protected endpoint created; unauthenticated reads and writes return 401.")
    print("No users were created or invited. Website sign-in is not enabled yet.")
    print(json.dumps({"region": REGION, **outputs}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raise SystemExit("STOPPED: " + str(error))
