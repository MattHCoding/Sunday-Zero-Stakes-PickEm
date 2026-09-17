"""Run in AWS CloudShell to add the classic Cognito hosted sign-in domain.
Does not create accounts, send invitations, or change picks.
"""
import boto3

REGION = 'us-east-2'
ACCOUNT = '442426890475'
POOL = 'us-east-2_AstbKn1rW'
DOMAIN = 'sunday-pickem-442426890475'


def main():
    if boto3.client('sts').get_caller_identity()['Account'] != ACCOUNT:
        raise RuntimeError('Wrong AWS account. No changes made.')
    client = boto3.client('cognito-idp', region_name=REGION)
    pool = client.describe_user_pool(UserPoolId=POOL)['UserPool']
    if pool.get('Domain') not in (None, '', DOMAIN):
        raise RuntimeError('Pool already has a different domain. No changes made.')
    existing = client.describe_user_pool_domain(Domain=DOMAIN).get('DomainDescription', {})
    if existing.get('UserPoolId') and existing['UserPoolId'] != POOL:
        raise RuntimeError('Domain belongs to another pool. No changes made.')
    if not existing.get('UserPoolId'):
        client.create_user_pool_domain(UserPoolId=POOL, Domain=DOMAIN, ManagedLoginVersion=1)
    print('Sign-in domain configured. It can take one minute to become available.')
    print('No accounts created or invitations sent. A user account is still required.')


if __name__ == '__main__':
    main()
