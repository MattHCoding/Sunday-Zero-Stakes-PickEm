"""Authenticated HTTP API for picks. Deploy behind an API Gateway JWT authorizer."""
import base64
import json
import logging
import os
from datetime import datetime, timezone
from decimal import Decimal
from urllib.request import Request, urlopen

import boto3
from botocore.exceptions import ClientError

TABLE_NAME = "SundayPickEm-Picks"
TABLE = boto3.resource("dynamodb", region_name="us-east-2").Table(TABLE_NAME)
LOG = logging.getLogger(__name__)


class ApiError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def response(status, body):
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json", "cache-control": "no-store"},
        "body": json.dumps(body, default=lambda value: float(value) if isinstance(value, Decimal) else str(value)),
    }


def period(values):
    try:
        year, week = int(values["seasonYear"]), int(values["weekNumber"])
        if str(year) != str(values["seasonYear"]) or str(week) != str(values["weekNumber"]):
            raise ValueError()
        if not 2000 <= year <= 2100 or not 1 <= week <= 18:
            raise ValueError()
        return year, week
    except (KeyError, TypeError, ValueError):
        raise ApiError(400, "Provide a valid seasonYear and weekNumber.")


def user_id(event):
    claims = event.get("requestContext", {}).get("authorizer", {}).get("jwt", {}).get("claims", {})
    if not claims.get("sub") or claims.get("token_use") != "access":
        raise ApiError(401, "Sign in to access your picks.")
    issuer, client = os.environ.get("USER_POOL_ISSUER"), os.environ.get("APP_CLIENT_ID")
    if not issuer or not client:
        raise ApiError(503, "Sign-in is not configured yet.")
    if claims.get("iss") != issuer or claims.get("client_id") != client:
        raise ApiError(401, "Sign in to access your picks.")
    # Claims must come from the API Gateway JWT authorizer, never the request body.
    return claims["sub"]


def fetch_game(year, week, event_id):
    url = f"https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates={year}&seasontype=2&week={week}&limit=1000"
    try:
        with urlopen(Request(url, headers={"Accept": "application/json"}), timeout=5) as result:
            feed = json.load(result)
        if feed.get("season", {}).get("year") != year or feed.get("week", {}).get("number") != week:
            raise ValueError("Schedule period mismatch")
        return next((game for game in feed.get("events", []) if game.get("id") == event_id), None)
    except Exception:
        raise ApiError(503, "Could not verify the current game and line. Try again.")


def list_picks(uid, year, week):
    request = {
        "KeyConditionExpression": "userId = :user AND begins_with(pickId, :prefix)",
        "ExpressionAttributeValues": {":user": uid, ":prefix": f"{year}#{week:02d}#"},
        "ConsistentRead": True,
    }
    picks = []
    while True:
        result = TABLE.query(**request)
        picks.extend({k: v for k, v in row.items() if k != "userId"} for row in result.get("Items", []))
        if not result.get("LastEvaluatedKey"):
            break
        request["ExclusiveStartKey"] = result["LastEvaluatedKey"]
    return response(200, {"picks": picks})


def save_pick(uid, event_id, body):
    if set(body) - {"seasonYear", "weekNumber", "selectionHomeAway"}:
        raise ApiError(400, "Only seasonYear, weekNumber, and selectionHomeAway are accepted.")
    year, week = period(body)
    side = body.get("selectionHomeAway")
    if side not in ("home", "away") or not event_id.isdigit() or len(event_id) > 20:
        raise ApiError(400, "Invalid game or selection.")
    game = fetch_game(year, week, event_id)
    if game is None:
        raise ApiError(404, "Game not found in that week.")
    competition = (game.get("competitions") or [{}])[0]
    try:
        kickoff = datetime.fromisoformat(game["date"].replace("Z", "+00:00"))
        if kickoff.tzinfo is None:
            raise ValueError()
    except (KeyError, TypeError, ValueError):
        raise ApiError(503, "Could not verify kickoff time.")
    if competition.get("status", {}).get("type", {}).get("state") != "pre" or kickoff <= datetime.now(timezone.utc):
        raise ApiError(409, "Picks are locked for this game.")
    odds = (competition.get("odds") or [{}])[0]
    raw_line = odds.get("pointSpread", {}).get("home", {}).get("close", {}).get("line")
    if raw_line is None:
        raw_line = odds.get("spread")
    try:
        line = Decimal("0") if str(raw_line).strip().upper() in ("PK", "PICK", "EVEN") else Decimal(str(raw_line))
        if not line.is_finite():
            raise ValueError()
    except Exception:
        raise ApiError(409, "A point spread is not available for this game yet.")
    teams = {c.get("homeAway"): c.get("team", {}) for c in competition.get("competitors", [])}
    if not all(teams.get(s, {}).get("abbreviation") for s in ("home", "away")):
        raise ApiError(503, "Could not verify the teams.")
    now = datetime.now(timezone.utc)
    if now >= kickoff:
        raise ApiError(409, "Picks are locked for this game.")
    item = {
        "userId": uid, "pickId": f"{year}#{week:02d}#{event_id}",
        "eventId": event_id, "seasonYear": year, "weekNumber": week,
        "selectionHomeAway": side, "spread": line if side == "home" else -line,
        "homeTeam": teams["home"]["abbreviation"], "awayTeam": teams["away"]["abbreviation"],
        "kickoffEpoch": int(kickoff.timestamp()), "savedAt": now.isoformat(),
    }
    try:
        TABLE.put_item(
            Item=item,
            ConditionExpression="attribute_not_exists(pickId) OR kickoffEpoch > :now",
            ExpressionAttributeValues={":now": Decimal(str(now.timestamp()))},
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise ApiError(409, "Picks are locked for this game.")
        raise
    return response(200, {"pick": {k: v for k, v in item.items() if k != "userId"}})


def handler(event, context):
    try:
        uid = user_id(event)
        route = event.get("routeKey")
        if route == "GET /picks":
            year, week = period(event.get("queryStringParameters") or {})
            return list_picks(uid, year, week)
        if route == "PUT /picks/{eventId}":
            raw = event.get("body") or ""
            if len(raw) > 6000:
                raise ApiError(413, "Pick request is too large.")
            try:
                if event.get("isBase64Encoded"):
                    raw = base64.b64decode(raw, validate=True).decode("utf-8")
                body = json.loads(raw)
                if not isinstance(body, dict):
                    raise ValueError()
            except (ValueError, TypeError, UnicodeError):
                raise ApiError(400, "Invalid pick request.")
            return save_pick(uid, (event.get("pathParameters") or {}).get("eventId", ""), body)
        raise ApiError(404, "Route not found.")
    except ApiError as exc:
        return response(exc.status, {"error": exc.message})
    except Exception:
        LOG.exception("Picks API failure")
        return response(503, {"error": "Could not save or load picks. Try again."})
