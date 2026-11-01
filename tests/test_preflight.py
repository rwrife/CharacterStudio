"""Model setup states without network requests or real credentials."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from huggingface_hub.errors import GatedRepoError, HfHubHTTPError, LocalEntryNotFoundError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from preflight import check_text_encoder, check_lfm_encoder, check_gpu


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


class LFMAccessTests(unittest.TestCase):
    def test_cached_lfm_does_not_check_llama_or_credentials(self):
        with patch("studio_kimodo_lfm.assets.resolve_assets"), patch("huggingface_hub.get_token") as token:
            check = check_lfm_encoder()
        self.assertEqual(check["status"], "warning")
        self.assertIn("Experimental", check["detail"])
        token.assert_not_called()

    def test_missing_assets_require_setup_not_model_approval(self):
        for error in (FileNotFoundError(), LocalEntryNotFoundError("offline")):
            with self.subTest(error=type(error).__name__), patch("studio_kimodo_lfm.assets.resolve_assets", side_effect=error):
                check = check_lfm_encoder()
            self.assertEqual(check["status"], "blocked")
            self.assertIn("setup-lfm.ps1", check["detail"])
            self.assertIn("No Llama approval", check["detail"])


class GPUMemoryTests(unittest.TestCase):
    def test_reports_free_and_total_memory_in_gib(self):
        with patch("torch.cuda.is_available", return_value=True), patch("torch.cuda.current_device", return_value=0), \
                patch("torch.cuda.get_device_name", return_value="Test GPU"), \
                patch("torch.cuda.mem_get_info", return_value=(8 * 1024 ** 3, 24 * 1024 ** 3)):
            result = check_gpu()
        self.assertEqual(result["gpu"], {"name": "Test GPU", "freeGB": 8, "totalGB": 24})

    def test_cpu_has_no_invented_memory(self):
        with patch("torch.cuda.is_available", return_value=False):
            result = check_gpu()
        self.assertEqual(result["status"], "warning")
        self.assertNotIn("gpu", result)

    def test_driver_query_failure_is_explicit(self):
        with patch("torch.cuda.is_available", return_value=True), patch("torch.cuda.current_device", return_value=0), \
                patch("torch.cuda.get_device_name", return_value="Test GPU"), \
                patch("torch.cuda.mem_get_info", side_effect=RuntimeError("test driver failure")):
            result = check_gpu()
        self.assertEqual(result["status"], "warning")
        self.assertIn("memory detection failed", result["detail"])
        self.assertNotIn("gpu", result)


if __name__ == "__main__":
    unittest.main()
