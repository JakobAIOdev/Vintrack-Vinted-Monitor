#!/usr/bin/env python3
"""Create an offline, allowlisted search HAR for REA; never replay requests."""

import argparse
import base64
import hashlib
import json
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


PATHS = {"/api/v2/homepage", "/api/v2/homepage/all", "/api/v2/catalog/items"}
HOSTS = {"www.vinted.fr", "www.vinted.de"}
PARAMS = {"catalog_ids", "brand_ids", "order", "page", "per_page", "currency", "column_count", "version"}
HEADERS = {"user-agent", "accept", "accept-language", "content-type", "cache-control", "cf-cache-status", "date"}


def item_projection(item):
    return {key: item[key] for key in ("id", "content_source", "promoted") if key in item}


def project(har):
    entries = []
    for entry in har["log"]["entries"]:
        request, response = entry["request"], entry["response"]
        parsed = urlsplit(request["url"])
        selected = parsed.scheme == "https" and parsed.hostname in HOSTS and parsed.path in PATHS
        query = [(key, value) for key, value in parse_qsl(parsed.query) if key in PARAMS] if selected else []
        url = urlunsplit(("https", parsed.hostname, parsed.path, urlencode(query), "")) if selected else "https://redacted.invalid/omitted"

        def headers(source):
            return [header for header in source if selected and header["name"].lower() in HEADERS]

        original_content = response.get("content", {})
        content = {"size": original_content.get("size", 0), "mimeType": original_content.get("mimeType", "") if selected else ""}
        if selected and parsed.path != "/api/v2/homepage" and original_content.get("text"):
            text = original_content["text"]
            if original_content.get("encoding") == "base64":
                text = base64.b64decode(text, validate=True).decode("utf-8")
            body = json.loads(text)
            if parsed.path == "/api/v2/catalog/items":
                body = {"items": [item_projection(item) for item in body.get("items", [])]}
            else:
                body = {"blocks": [{"type": "item", "entity": item_projection(block.get("entity", {}))}
                                   for block in body.get("blocks", []) if block.get("type") == "item"]}
            content["text"] = json.dumps(body)
        entries.append({
            "startedDateTime": entry["startedDateTime"], "time": entry["time"], "timings": entry["timings"],
            "request": {"method": request["method"], "url": url, "httpVersion": request["httpVersion"],
                        "headers": headers(request.get("headers", [])), "cookies": [],
                        "queryString": [{"name": key, "value": value} for key, value in query],
                        "headersSize": -1, "bodySize": 0},
            "response": {"status": response["status"], "statusText": response["statusText"],
                         "httpVersion": response["httpVersion"], "headers": headers(response.get("headers", [])),
                         "cookies": [], "content": content, "redirectURL": "", "headersSize": -1,
                         "bodySize": response.get("bodySize", -1)}, "cache": {},
        })
    return {"log": {"version": "1.2", "creator": {"name": "vintrack-privacy-projection", "version": "1"}, "entries": entries}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    if args.source.resolve() == args.destination.resolve():
        parser.error("destination must differ from original HAR")
    raw = args.source.read_bytes()
    projected = json.dumps(project(json.loads(raw))).encode()
    # Refuse overwrites, including symlinks, so the original capture stays intact.
    with args.destination.open("xb") as output:
        output.write(projected)
    print(json.dumps({"source_sha256": hashlib.sha256(raw).hexdigest(), "source_bytes": len(raw),
                      "projection_sha256": hashlib.sha256(projected).hexdigest(), "projection_bytes": len(projected)}))


if __name__ == "__main__":
    main()
