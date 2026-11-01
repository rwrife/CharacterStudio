"""Read-only environment/access probe. Never print or accept credentials."""
import json
import sys
from pathlib import Path


def check_text_encoder():
    from httpx import TransportError
    from huggingface_hub import get_token, try_to_load_from_cache, get_hf_file_metadata, hf_hub_url
    from huggingface_hub.errors import GatedRepoError, HfHubHTTPError, LocalTokenNotFoundError

    repo = "meta-llama/Meta-Llama-3-8B-Instruct"
    filename = "model-00001-of-00004.safetensors"
    cached = [try_to_load_from_cache(repo, f"model-{i:05d}-of-00004.safetensors") for i in range(1, 5)]
    status = "blocked"
    if all(isinstance(p, str) and Path(p).is_file() for p in cached):
        status = "ready"
        detail = "All four base-model weight shards are cached locally. Inference runs on this PC. Tokenizer/configuration and LLM2Vec adapters must also be available when generating."
    else:
        token = get_token()
        if not token:
            detail = "Local weights are missing and no Hugging Face login was found. Request access to Meta-Llama-3-8B-Instruct, then run hf auth login in the ComfyUI environment with the same account. Browser login alone does not sign in this PC."
        else:
            try:
                get_hf_file_metadata(hf_hub_url(repo, filename), token=token, timeout=15)
                status = "warning"
                detail = "Download access authorized. First generation downloads local Llama/LLM2Vec weights (many GB); inference runs on this PC."
            except GatedRepoError:
                detail = "Hugging Face denied access to Meta-Llama-3-8B-Instruct. The account may still need model-owner approval, or its token may lack gated-model read permission. Check the exact model page and use the same approved account locally."
            except LocalTokenNotFoundError:
                detail = "Hugging Face could not find local credentials. Sign in with hf auth login in the ComfyUI environment using the approved account."
            except HfHubHTTPError as exc:
                code = getattr(exc.response, "status_code", None)
                if code == 401:
                    detail = "Hugging Face rejected the local login (HTTP 401). The token may be expired or invalid. Sign in again with hf auth login --force using the approved account."
                elif code == 403:
                    detail = "Hugging Face refused this download (HTTP 403). Check model approval, the active account, and the token's read permission for gated repositories."
                else:
                    detail = f"Hugging Face access check returned HTTP {code}. This does not establish whether model approval is missing. Check service/network availability and retry."
            except (OSError, TimeoutError, TransportError) as exc:
                detail = f"Could not reach Hugging Face to verify access ({type(exc).__name__}). Check the network and retry; this is not evidence that model access was denied."
    if status == "blocked":
        detail += " See Backend connections > Model access & local setup. Never paste a token into Studio or chat."
    return {"name": "Local Llama text encoder", "status": status, "detail": detail}


def main():
    import torch

    checks = [{"name": "PyTorch / GPU", "status": "ready" if torch.cuda.is_available() else "warning",
               "detail": f"torch {torch.__version__}; CUDA {'available' if torch.cuda.is_available() else 'unavailable (CPU generation is slow)'}"}]
    checks.append(check_text_encoder())
    print("STUDIO_CHECKS:" + json.dumps(checks), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("STUDIO_CHECKS:" + json.dumps([{"name": "Comfy Python", "status": "blocked",
              "detail": f"Environment probe failed: {type(exc).__name__}: {exc}"}]), flush=True)
        sys.exit(1)
