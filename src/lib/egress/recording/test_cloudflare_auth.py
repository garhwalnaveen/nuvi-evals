import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import addon

from cloudflare_auth import authorization


class CloudflareAuthorizationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.credentials = Path(self.directory.name) / "credentials.json"
        self.account = "0" * 32
        self.path = f"/client/v4/accounts/{self.account}/ai/v1/chat/completions"
        self.body = json.dumps({"model": "@cf/example/model"}).encode()
        self.credentials.write_text(json.dumps({
            "accountId": self.account,
            "token": "test-token",
            "models": ["@cf/example/model"],
        }))

    def test_authorizes_only_selected_model_call(self):
        self.assertEqual(
            authorization("POST", self.path, self.body, self.credentials),
            "Bearer test-token",
        )

    def test_rejects_other_account_routes_methods_and_query_parameters(self):
        for method, path in [
            ("GET", self.path),
            ("POST", self.path.replace(self.account, "1" * 32)),
            ("POST", "/client/v4/accounts/" + self.account),
            ("POST", self.path + "?redirect=example.org"),
        ]:
            with self.subTest(method=method, path=path), self.assertRaises(ValueError):
                authorization(method, path, self.body, self.credentials)

    def test_rejects_other_models_and_invalid_bodies(self):
        for body in [b"{}", b"null", b"invalid", b'{"model":"@cf/example/other"}']:
            with self.subTest(body=body), self.assertRaises(ValueError):
                authorization("POST", self.path, body, self.credentials)

    def test_missing_credentials_fail_closed(self):
        self.credentials.unlink()
        with self.assertRaises(FileNotFoundError):
            authorization("POST", self.path, self.body, self.credentials)

    def test_request_hook_denies_without_credentials_even_when_fixtures_are_disabled(self):
        flow = SimpleNamespace(request=SimpleNamespace(
            pretty_host="api.cloudflare.com", method="POST",
            path=self.path, content=self.body, headers={},
        ), response=None)
        response_factory = SimpleNamespace(make=lambda status, body, headers: status)
        with patch.object(addon, "http", SimpleNamespace(Response=response_factory)), \
                patch.object(addon, "PLUGIN_FIXTURES_DIR", None), \
                patch.object(addon.cloudflare_auth, "authorization", side_effect=ValueError("private-error")):
            addon.request(flow)
        self.assertEqual(flow.response, 403)
        self.assertNotIn("Authorization", flow.request.headers)


if __name__ == "__main__":
    unittest.main()
