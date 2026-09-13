"""Run once in AWS CloudShell to grant the reviewed PickEm API permissions."""
import json
import subprocess

ACCOUNT = "442426890475"
REGION = "us-east-2"
RUNTIME = "PickEm-ApiRuntime"
DEPLOY = "PickEm-GitHub-Deploy"
ROLE_ARN = f"arn:aws:iam::{ACCOUNT}:role/{RUNTIME}"
FUNCTION_ARN = f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:SundayPickEm-Api"
TABLE_ARN = f"arn:aws:dynamodb:{REGION}:{ACCOUNT}:table/SundayPickEm-Picks"
LOG_ARN = f"arn:aws:logs:{REGION}:{ACCOUNT}:log-group:/aws/lambda/SundayPickEm-Api:*"


def aws(service, operation, *, missing_ok=False, **parameters):
    args = ["aws", service, operation, "--region", REGION, "--output", "json", "--no-cli-pager"]
    for key, value in parameters.items():
        args += ["--" + key.replace("_", "-"), json.dumps(value) if isinstance(value, (dict, list)) else str(value)]
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode:
        if missing_ok and "(NoSuchEntity)" in result.stderr:
            return None
        raise RuntimeError(result.stderr.strip())
    return json.loads(result.stdout) if result.stdout.strip() else {}


trust = {
    "Version": "2012-10-17",
    "Statement": [{
        "Effect": "Allow", "Principal": {"Service": "lambda.amazonaws.com"},
        "Action": "sts:AssumeRole"
    }]
}
runtime_policy = {
    "Version": "2012-10-17",
    "Statement": [
        {"Sid": "ReadAndSavePicks", "Effect": "Allow",
         "Action": ["dynamodb:Query", "dynamodb:PutItem"], "Resource": TABLE_ARN},
        {"Sid": "WriteFunctionLogs", "Effect": "Allow",
         "Action": ["logs:CreateLogStream", "logs:PutLogEvents"], "Resource": LOG_ARN}
    ]
}
deploy_policy = {
    "Version": "2012-10-17",
    "Statement": [
        {"Sid": "DeployOneApiFunction", "Effect": "Allow", "Resource": FUNCTION_ARN,
         "Action": ["lambda:CreateFunction", "lambda:GetFunction",
                    "lambda:GetFunctionConfiguration", "lambda:UpdateFunctionCode",
                    "lambda:UpdateFunctionConfiguration", "lambda:TagResource",
                    "lambda:ListTags"]},
        {"Sid": "PassOnlyTheApiRoleToLambda", "Effect": "Allow",
         "Action": "iam:PassRole", "Resource": ROLE_ARN,
         "Condition": {"StringEquals": {"iam:PassedToService": "lambda.amazonaws.com"}}},
        {"Sid": "InspectApiRole", "Effect": "Allow",
         "Action": "iam:GetRole", "Resource": ROLE_ARN},
        {"Sid": "SetUpApiLogs", "Effect": "Allow", "Resource": LOG_ARN,
         "Action": ["logs:CreateLogGroup", "logs:PutRetentionPolicy"]}
    ]
}


def main():
    identity = aws("sts", "get-caller-identity")
    if identity["Account"] != ACCOUNT:
        raise RuntimeError("Wrong AWS account. No changes made.")
    aws("iam", "get-role", role_name=DEPLOY)
    role = aws("iam", "get-role", role_name=RUNTIME, missing_ok=True)
    if role:
        statements = role["Role"]["AssumeRolePolicyDocument"].get("Statement", [])
        if isinstance(statements, dict):
            statements = [statements]
        normalized = [{k: v for k, v in entry.items() if k != "Sid"} for entry in statements]
        if normalized != trust["Statement"]:
            raise RuntimeError("Existing API role has a different trust policy. Stop and share this error.")
        attached = aws("iam", "list-attached-role-policies", role_name=RUNTIME)["AttachedPolicies"]
        inline = aws("iam", "list-role-policies", role_name=RUNTIME)["PolicyNames"]
        if attached or set(inline) - {"PickEm-RuntimeAccess"}:
            raise RuntimeError("Existing API role has additional permissions. Stop and share this error.")
        print("Reusing the existing Lambda-only API role.")
    else:
        aws("iam", "create-role", role_name=RUNTIME,
            assume_role_policy_document=trust,
            description="Runtime role for the SundayPickEm API in us-east-2")
        print("Created the Lambda-only API role.")

    aws("iam", "put-role-policy", role_name=RUNTIME,
        policy_name="PickEm-RuntimeAccess", policy_document=runtime_policy)
    print("Attached read/save permission for the picks table and function logs.")
    aws("iam", "put-role-policy", role_name=DEPLOY,
        policy_name="PickEm-LambdaDeploy", policy_document=deploy_policy)
    print("Attached deployment permission for SundayPickEm-Api.")

    for name, policy_name, expected in [
        (RUNTIME, "PickEm-RuntimeAccess", runtime_policy),
        (DEPLOY, "PickEm-LambdaDeploy", deploy_policy),
    ]:
        actual = aws("iam", "get-role-policy", role_name=name, policy_name=policy_name)
        if actual["PolicyDocument"] != expected:
            raise RuntimeError("Policy verification failed: " + policy_name)
    print("SUCCESS: API runtime and Lambda deployment permissions are configured.")
    print("No Lambda function or public endpoint was created. No pick data was changed.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raise SystemExit("STOPPED: " + str(error))
