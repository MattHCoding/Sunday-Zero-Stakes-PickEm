import importlib.util
import json
import os
import sys
import types
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import Mock, patch


class ClientError(Exception):
    def __init__(self, code):
        self.response = {"Error": {"Code": code}}


table = Mock()
with patch.dict(sys.modules, {
    "boto3": types.SimpleNamespace(resource=lambda *a, **kw: types.SimpleNamespace(Table=lambda name: table)),
    "botocore.exceptions": types.SimpleNamespace(ClientError=ClientError),
}):
    spec = importlib.util.spec_from_file_location("picks_handler", Path(__file__).parents[1] / "backend/handler.py")
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)


class PicksTests(unittest.TestCase):
    def setUp(self):
        table.reset_mock()
        table.put_item.side_effect = None
        table.query.side_effect = None
        self.env = patch.dict(os.environ, {"USER_POOL_ISSUER": "issuer", "APP_CLIENT_ID": "client"})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.event = {
            "routeKey": "PUT /picks/{eventId}", "pathParameters": {"eventId": "123"},
            "requestContext": {"authorizer": {"jwt": {"claims": {
                "sub": "user-a", "token_use": "access", "iss": "issuer", "client_id": "client",
            }}}},
            "body": json.dumps({"seasonYear": 2099, "weekNumber": 1, "selectionHomeAway": "away"}),
        }
        self.game = {
            "id": "123", "date": "2099-09-13T17:00Z",
            "competitions": [{"status": {"type": {"state": "pre"}},
                "odds": [{"spread": -3.5}], "competitors": [
                    {"homeAway": "home", "team": {"abbreviation": "CIN"}},
                    {"homeAway": "away", "team": {"abbreviation": "TB"}},
                ]}],
        }
        self.fetcher = patch.object(api, "fetch_game", return_value=self.game)
        self.fetcher.start()
        self.addCleanup(self.fetcher.stop)

    def test_rejects_missing_authentication_and_id_token(self):
        event = deepcopy(self.event)
        event.pop("requestContext")
        self.assertEqual(api.handler(event, None)["statusCode"], 401)
        self.event["requestContext"]["authorizer"]["jwt"]["claims"]["token_use"] = "id"
        self.assertEqual(api.handler(self.event, None)["statusCode"], 401)
        table.put_item.assert_not_called()

    def test_rejects_wrong_client(self):
        self.event["requestContext"]["authorizer"]["jwt"]["claims"]["client_id"] = "other"
        self.assertEqual(api.handler(self.event, None)["statusCode"], 401)

    def test_rejects_client_identity_and_spread(self):
        for field in ["userId", "spread", "kickoffEpoch"]:
            event = deepcopy(self.event)
            event["body"] = json.dumps({**json.loads(event["body"]), field: "tampered"})
            self.assertEqual(api.handler(event, None)["statusCode"], 400)
        table.put_item.assert_not_called()

    def test_saves_authoritative_user_and_opposite_spread(self):
        result = api.handler(self.event, None)
        self.assertEqual(result["statusCode"], 200)
        saved = table.put_item.call_args.kwargs["Item"]
        self.assertEqual(saved["userId"], "user-a")
        self.assertEqual(saved["pickId"], "2099#01#123")
        self.assertEqual(saved["spread"], 3.5)
        self.assertNotIn("userId", json.loads(result["body"])["pick"])

    def test_missing_spread_and_started_game_fail_closed(self):
        self.game["competitions"][0]["odds"] = []
        self.assertEqual(api.handler(self.event, None)["statusCode"], 409)
        self.game["date"] = "2020-09-13T17:00Z"
        self.assertEqual(api.handler(self.event, None)["statusCode"], 409)
        table.put_item.assert_not_called()

    def test_existing_locked_pick_cannot_be_overwritten(self):
        table.put_item.side_effect = ClientError("ConditionalCheckFailedException")
        self.assertEqual(api.handler(self.event, None)["statusCode"], 409)

    def test_queries_only_authenticated_users_week_including_pagination(self):
        table.query.side_effect = [
            {"Items": [{"userId": "user-a", "pickId": "2099#01#123"}], "LastEvaluatedKey": {"userId": "user-a", "pickId": "2099#01#123"}},
            {"Items": [{"userId": "user-a", "pickId": "2099#01#456"}]},
        ]
        self.event["routeKey"] = "GET /picks"
        self.event["queryStringParameters"] = {"seasonYear": "2099", "weekNumber": "1", "userId": "user-b"}
        result = api.handler(self.event, None)
        self.assertEqual(len(json.loads(result["body"])["picks"]), 2)
        for call in table.query.call_args_list:
            self.assertEqual(call.kwargs["ExpressionAttributeValues"], {":user": "user-a", ":prefix": "2099#01#"})


if __name__ == "__main__":
    unittest.main()
