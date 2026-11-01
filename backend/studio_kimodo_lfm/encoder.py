"""Experimental local LFM conditioning in Kimodo's 4096-dimensional space."""
import importlib.util
import json
import logging
from types import MethodType

import numpy as np
import torch
from torch import nn
from torch.nn import functional as F

from .assets import resolve_assets, verify_assets

log = logging.getLogger(__name__)


def noncausal_conv(module, hidden_states, past_key_values=None, attention_mask=None, seq_idx=None, cache_position=None):
    if past_key_values is not None or seq_idx is not None:
        raise ValueError("Cached or packed LFM sequences are not supported by the bridge recipe")
    # Symmetric convolution with unmasked pad states matches the pinned bidirectional checkpoint.
    gate_in, gate_out, values = module.in_proj(hidden_states).transpose(1, 2).chunk(3, dim=1)
    filtered = F.conv1d(gate_in * values, module.conv.weight, module.conv.bias,
                        padding=module.conv.weight.shape[-1] // 2, groups=values.shape[1])
    length = values.shape[-1]
    filtered = F.pad(filtered, (0, max(0, length - filtered.shape[-1])))[..., :length]
    return module.out_proj((gate_out * filtered).transpose(1, 2).contiguous())


def map_features(mapper, features, device):
    mapped = np.asarray(mapper.transform(features), dtype=np.float32)
    if mapped.shape != (len(features), 4096) or not np.isfinite(mapped).all():
        raise ValueError("LFM bridge returned invalid conditioning; expected finite (N, 4096) vectors")
    return torch.from_numpy(mapped).unsqueeze(1).to(device), [1] * len(features)


class LFMBridgeEncoder(nn.Module):
    def __init__(self):
        super().__init__()
        from transformers import AutoTokenizer, Lfm2Model
        from transformers.models.lfm2.modeling_lfm2 import Lfm2ShortConv, Lfm2Attention

        model_dir, bridge_dir = resolve_assets()
        self.recipe = verify_assets(model_dir, bridge_dir)
        pooling = json.loads((model_dir / "1_Pooling" / "config.json").read_text(encoding="utf-8"))
        prompts = json.loads((model_dir / "config_sentence_transformers.json").read_text(encoding="utf-8"))
        if (prompts["prompts"]["document"] != "document: "
                or [key for key, value in pooling.items() if key.startswith("pooling_mode_") and value] != ["pooling_mode_cls_token"]
                or pooling["word_embedding_dimension"] != 1024 or not pooling.get("include_prompt", True)):
            raise ValueError("LFM model pooling/prompt no longer matches the bridge recipe")
        spec = importlib.util.spec_from_file_location("studio_lfm_bridge_v2", bridge_dir / "v2" / "bridge.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.mapper = module.Bridge(bridge_dir / "v2")
        if self.mapper.input_dim != 1024 or self.mapper.output_dim != 4096:
            raise ValueError("Incompatible LFM bridge dimensions")
        self.tokenizer = AutoTokenizer.from_pretrained(model_dir, local_files_only=True, trust_remote_code=False)
        self.backbone = Lfm2Model.from_pretrained(
            model_dir, local_files_only=True,
            dtype=torch.float32, attn_implementation="sdpa",
        ).eval().requires_grad_(False)
        self.backbone.config.use_cache = False
        self.backbone.float()
        convolutions = 0
        for module in self.backbone.modules():
            if isinstance(module, Lfm2ShortConv):
                module.forward = MethodType(noncausal_conv, module)
                convolutions += 1
            elif isinstance(module, Lfm2Attention):
                module.is_causal = False
        if convolutions != sum(kind == "conv" for kind in self.backbone.config.layer_types):
            raise RuntimeError("LFM legacy masking does not cover every short-convolution layer")
        log.warning("Experimental LFM bridge: approximate LLM2Vec conditioning, not equivalent motion quality. "
                    "This ComfyUI environment differs from the author's calibrated dependency versions.")

    @torch.inference_mode()
    def forward(self, texts):
        if isinstance(texts, str):
            texts = [texts]
        if not texts or any(not isinstance(text, str) for text in texts):
            raise ValueError("LFM encoder requires a nonempty list of text strings")
        device = next(self.backbone.parameters()).device
        features = []
        # Padding follows the bridge's 64-caption reference groups; never normalize CLS vectors.
        for start in range(0, len(texts), 64):
            tokens = self.tokenizer(["document: " + text.strip() for text in texts[start:start + 64]],
                                    padding=True, truncation=True, max_length=512, return_tensors="pt").to(device)
            valid = tokens.pop("attention_mask")
            mask = (1 - valid.float())[:, None, None, :].expand(-1, 1, valid.shape[1], -1) * -1e9
            hidden = self.backbone(**tokens, attention_mask={"full_attention": mask, "conv": None}).last_hidden_state
            features.append(hidden[:, 0].float().cpu().numpy())
        return map_features(self.mapper, np.concatenate(features), device)
