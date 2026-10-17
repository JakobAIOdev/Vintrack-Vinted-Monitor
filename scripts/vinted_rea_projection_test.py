import copy
import json
from pathlib import Path
import runpy
import unittest


project = runpy.run_path(str(Path(__file__).with_name("vinted-rea-har-projection.py")))["project"]


class ProjectionTests(unittest.TestCase):
    def capture(self):
        return {"log": {"entries": [{
            "startedDateTime": "2026-03-30T17:16:52+02:00", "time": 750.46,
            "timings": {"send": 1, "wait": 748, "receive": 1.46},
            "request": {"method": "GET", "httpVersion": "HTTP/1.1",
                        "url": "https://www.vinted.fr/api/v2/catalog/items?order=relevance&session_id=SECRET",
                        "headers": [{"name": "Authorization", "value": "SECRET"}, {"name": "X-Unknown", "value": "SECRET"}],
                        "cookies": [{"name": "session", "value": "SECRET"}], "postData": {"text": "SECRET"}},
            "response": {"status": 200, "statusText": "OK", "httpVersion": "HTTP/1.1",
                         "headers": [{"name": "Set-Cookie", "value": "SECRET"}],
                         "cookies": [{"name": "session", "value": "SECRET", "expires": "malformed"}],
                         "content": {"size": 123, "mimeType": "application/json", "text": json.dumps({
                             "token": "SECRET", "items": [{"id": 123, "content_source": "catalog", "promoted": False,
                                                              "user": {"token": "SECRET"}, "description": "SECRET"}]})}},
        }]}}

    def test_allowlist_strips_credentials_and_nested_data_without_mutating_source(self):
        capture = self.capture()
        original = copy.deepcopy(capture)
        result = project(capture)
        self.assertNotIn("SECRET", json.dumps(result))
        self.assertEqual(capture, original)
        entry = result["log"]["entries"][0]
        self.assertEqual(entry["time"], 750.46)
        self.assertEqual(entry["response"]["content"]["size"], 123)
        self.assertEqual(json.loads(entry["response"]["content"]["text"])["items"],
                         [{"id": 123, "content_source": "catalog", "promoted": False}])

    def test_unselected_routes_keep_ordinals_but_drop_urls_and_content(self):
        capture = self.capture()
        omitted = copy.deepcopy(capture["log"]["entries"][0])
        omitted["request"]["url"] = "https://www.vinted.fr/oauth/token?secret=SECRET"
        capture["log"]["entries"].insert(0, omitted)
        result = project(capture)["log"]["entries"]
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]["request"]["url"], "https://redacted.invalid/omitted")
        self.assertNotIn("text", result[0]["response"]["content"])
        self.assertEqual(result[1]["request"]["url"], "https://www.vinted.fr/api/v2/catalog/items?order=relevance")
        self.assertNotIn("SECRET", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
