"""Model setup states without network requests or real credentials."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from huggingface_hub.errors import GatedRepoError, HfHubHTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from preflight import check_text_encoder


class ModelAccessTests(unittest.TestCase):
    def setUp(self):
        self.cache = self.enterContext(patch("huggingface_hub.try_to_load_from_cache", return_value=None))
        self.token = self.enterContext(patch("huggingface_hub.get_token", return_value="test-credential-not-for-output"))
        self.metadata = self.enterContext(patch("huggingface_hub.get_hf_file_metadata"))

    def check_blocked(self, fragment):
        check = check_text_encoder()
        self.assertEqual(check["status"], "blocked")
        self.assertIn(fragment, check["detail"])
        self.assertIn("Model access & local setup", check["detail"])
        self.assertNotIn("test-credential-not-for-output", check["detail"])
        self.assertNotIn("sensitive-exception-detail", check["detail"])
        return check

    def test_existing_cache_does_not_require_another_login_or_access_check(self):
        self.cache.return_value = str(Path(__file__).resolve())
        self.assertEqual(check_text_encoder()["status"], "ready")
        self.token.assert_not_called()
        self.metadata.assert_not_called()

    def test_missing_login_has_distinct_instructions_and_makes_no_request(self):
        self.token.return_value = None
        self.check_blocked("no Hugging Face login")
        self.metadata.assert_not_called()

    def test_authorized_download_is_not_reported_as_cached_weights(self):
        check = check_text_encoder()
        self.assertEqual(check["status"], "warning")
        self.assertIn("Download access authorized", check["detail"])
        self.metadata.assert_called_once()

    def test_gated_download_mentions_account_approval_and_token_permissions(self):
        response = httpx.Response(403, request=httpx.Request("HEAD", "https://huggingface.co"))
        self.metadata.side_effect = GatedRepoError("sensitive-exception-detail", response=response)
        check = self.check_blocked("model-owner approval")
        self.assertIn("gated-model read permission", check["detail"])

    def test_http_errors_do_not_all_claim_missing_approval(self):
        for code, text in [(401, "expired or invalid"), (403, "read permission"), (503, "does not establish")]:
            with self.subTest(code=code):
                response = httpx.Response(code, request=httpx.Request("HEAD", "https://huggingface.co"))
                self.metadata.side_effect = HfHubHTTPError("sensitive-exception-detail", response=response)
                self.check_blocked(text)

    def test_network_failure_is_not_an_authorization_failure(self):
        self.metadata.side_effect = httpx.ConnectError("sensitive-exception-detail")
        self.check_blocked("not evidence that model access was denied")


if __name__ == "__main__":
    unittest.main()
