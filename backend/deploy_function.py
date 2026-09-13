"""Deploy only SundayPickEm-Api using the restricted GitHub role."""
import base64
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile

REGION = "us-east-2"
NAME = "SundayPickEm-Api"
ROLE = "arn:aws:iam::442426890475:role/PickEm-ApiRuntime"


def aws(service, operation, *, allow_error=None, **parameters):
    command = ["aws", service, operation, "--region", REGION, "--output", "json", "--no-cli-pager"]
    for key, value in parameters.items():
        command.extend(["--" + key.replace("_", "-"), json.dumps(value) if isinstance(value, (dict, list)) else str(value)])
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        if allow_error and "(" + allow_error + ")" in result.stderr:
            return None
        raise RuntimeError(result.stderr.strip())
    return json.loads(result.stdout) if result.stdout.strip() else {}


def wait(kind):
    subprocess.run(["aws", "lambda", "wait", kind, "--function-name", NAME, "--region", REGION], check=True, timeout=240)


def main():
    aws("logs", "create-log-group", log_group_name="/aws/lambda/" + NAME, allow_error="ResourceAlreadyExistsException")
    aws("logs", "put-retention-policy", log_group_name="/aws/lambda/" + NAME, retention_in_days=14)
    package = Path("pickem-function.zip")
    with zipfile.ZipFile(package, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.write(Path(__file__).with_name("handler.py"), "handler.py")
    current = aws("lambda", "get-function", function_name=NAME, allow_error="ResourceNotFoundException")
    if current is None:
        aws("lambda", "create-function", function_name=NAME, runtime="python3.13", role=ROLE,
            handler="handler.handler", timeout=10, memory_size=128,
            zip_file="fileb://" + str(package), tags={"Project": "Sunday-Zero-Stakes-PickEm"})
        wait("function-active-v2")
    else:
        config = current["Configuration"]
        if config["Role"] != ROLE:
            raise RuntimeError("Existing function uses an unexpected role; stopped without replacing it.")
        aws("lambda", "update-function-code", function_name=NAME, zip_file="fileb://" + str(package), revision_id=config["RevisionId"])
        wait("function-updated-v2")
        # Deliberately preserve Cognito environment settings applied during bootstrap.
        aws("lambda", "update-function-configuration", function_name=NAME, runtime="python3.13",
            role=ROLE, handler="handler.handler", timeout=10, memory_size=128)
        wait("function-updated-v2")
    actual = aws("lambda", "get-function-configuration", function_name=NAME)
    expected_hash = base64.b64encode(hashlib.sha256(package.read_bytes()).digest()).decode()
    assert actual["CodeSha256"] == expected_hash, "Deployed package does not match"
    assert actual["State"] == "Active", "Function is not active"
    assert actual["Role"] == ROLE
    assert actual["Runtime"] == "python3.13"
    assert actual["Handler"] == "handler.handler"
    print("VERIFIED: SundayPickEm-Api is Active in us-east-2 with the expected code and runtime role.")


if __name__ == "__main__":
    main()
