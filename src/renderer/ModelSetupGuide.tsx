import { ExternalLink, RefreshCw } from 'lucide-react'

interface Props {
  comfyRoot: string
  needsSetup: boolean
  checking: boolean
  textEncoder?: 'llm2vec' | 'lfm'
  onAccessPage(): void
  onTokenSettings(): void
  onRefresh(): void
}

export function ModelSetupGuide({ comfyRoot, needsSetup, checking, textEncoder = 'llm2vec', onAccessPage, onTokenSettings, onRefresh }: Props) {
  const hf = `& '${comfyRoot.replace(/[\\]+$/, '').replaceAll("'", "''")}\\venv\\Scripts\\hf.exe'`
  if (textEncoder === 'lfm') return <details className="model-setup-guide" open={needsSetup}>
    <summary>Model access &amp; local setup <span>Experimental ungated LFM</span></summary>
    <div className="model-setup-content">
      <p>Kimodo still generates the motion. <strong>LFM2.5-Embedding-350M + the community v2 bridge</strong> replaces only its text encoder.
        Downloads are public; no Llama approval or Hugging Face login is required. Inference runs locally; your FBX is not uploaded.</p>
      <p>From the source repository in PowerShell, run:</p>
      <pre aria-label="LFM setup command"><code>{`.\\scripts\\setup-lfm.ps1 -ComfyRoot '${comfyRoot.replaceAll("'", "''")}'`}</code></pre>
      <p>This downloads about 0.8 GB of pinned weights and installs the Studio Kimodo loader without replacing Python packages.
        Restart ComfyUI after installation, select <strong>LFM bridge</strong>, save settings, then refresh checks.
        A portable installation needs this one-time setup from the source repository too.</p>
      <p><strong>Experimental:</strong> embeddings approximate LLM2Vec, not identical motion quality. Review which hand moves, stance,
        foot contacts and graph joins. Pose constraints and seam validation remain enabled.
        Initial walk-to-punch branches failed endpoint checks; constrained graphs and loops are not production-validated with LFM.</p>
      <p>The bridge is Apache-2.0. LFM uses the LFM Open License v1.0 with a $10M annual-revenue commercial-use limitation;
        it is not an unrestricted MIT/Apache model.</p>
      <button className="secondary" disabled={checking} onClick={onRefresh}><RefreshCw size={14} className={checking ? 'spin' : ''} /> Refresh model access checks</button>
    </div>
  </details>
  return <details className="model-setup-guide" open={needsSetup}>
    <summary>Model access &amp; local setup <span>Start here for text generation</span></summary>
    <div className="model-setup-content">
      <p>Kimodo uses <strong>Meta-Llama-3-8B-Instruct with LLM2Vec adapters</strong> to understand motion instructions.
        Inference runs on your PC. Hugging Face supplies the initial downloads; your FBX is not uploaded.</p>
      <ol className="model-setup-steps">
        <li><h3>Request access to the exact model</h3>
          <p>Sign in to Hugging Face, then open <strong>meta-llama/Meta-Llama-3-8B-Instruct</strong>.
            On the Model card tab, find the license panel headed <strong>You need to agree to share your Hugging Face information to access this model</strong>.
            Click the wide <strong>Expand to review and access</strong> button below the license text.</p>
          <p>Review the terms and data-sharing notice, fill in the requested details, and submit only if you agree.
            You do not need <strong>Use this model</strong>, an inference provider, or a paid hosted endpoint.
            Do not substitute Llama 3.1 or another newer model.</p>
          <button className="secondary" onClick={onAccessPage}>Open Meta Llama model page <ExternalLink size={14} /></button>
        </li>
        <li><h3>Wait for approval</h3>
          <p>The model page must show that access has been granted. A pending request or a browser login alone does not grant download access.
            Approval is handled by the model owner, not Studio. Keep using the same account in the browser and on this PC.</p>
        </li>
        <li><h3>Sign in locally, outside Studio</h3>
          <p>Open PowerShell and run this command. It uses the existing Hugging Face CLI in your saved ComfyUI backend folder:</p>
          <pre aria-label="Hugging Face login command"><code>{hf} auth login</code></pre>
          <p>Choose browser sign-in if offered. If the CLI requests a token, create a <strong>read</strong> token on that same account;
            a fine-grained token must allow reading the gated model you have been approved for.
            Paste it only into the CLI's secure prompt, never into Studio or chat, and never into the command itself.
            Studio has no token field and does not store your credentials in its workspace.</p>
          <button className="secondary" onClick={onTokenSettings}>Open Hugging Face token settings <ExternalLink size={14} /></button>
          <p>Already signed in? Check the active account with:</p>
          <pre aria-label="Hugging Face account check command"><code>{hf} auth whoami</code></pre>
          <p>If it is the wrong account, run the login command again with <code>--force</code>.
            Existing users already signed in with sufficient permissions can skip this step.
            Do not reinstall or downgrade ComfyUI packages just to sign in.</p>
        </li>
        <li><h3>Refresh and generate locally</h3>
          <p>Refresh the readiness checks below, then use <strong>Start local ComfyUI</strong> if it is not running.
            Once access is recognized, generate a motion. The first run downloads many GB of base-model weights and adapters;
            keep enough free disk space and allow the download to finish. No remote inference subscription is needed.</p>
          <button className="secondary" disabled={checking} onClick={onRefresh}><RefreshCw size={14} className={checking ? 'spin' : ''} /> Refresh model access checks</button>
        </li>
      </ol>
      <details className="model-setup-help">
        <summary>Approved, but still blocked?</summary>
        <p>Confirm the exact model, the same browser/CLI account, and the token's read permissions for gated repositories.
          A token set through <code>HF_TOKEN</code> can override the saved CLI login; check the environment used to launch Studio without sharing its value.
          Restart an already-running ComfyUI after changing authentication. Network failures also block downloads; they do not mean access was denied.</p>
      </details>
      <details className="model-setup-help">
        <summary>Can I avoid the access request?</summary>
        <p>An already-authorized copy in the Hugging Face cache used by ComfyUI can be reused without requesting access again.
          A complete installation also needs the tokenizer, configuration, and both LLM2Vec adapters;
          Studio does not currently have an arbitrary local-model-folder selector.</p>
        <p>Studio also offers an experimental <strong>LFM bridge</strong> encoder in Backend connections.
          It avoids the Llama approval request while keeping Kimodo, but approximates its trained conditioning and can change motion details.
          vLLM, Ollama and generic chat embeddings are not compatible replacements.</p>
        <p>You can still import FBXs, fit and build rigs, and save configurations while access is pending. New text-generated motions remain unavailable.</p>
      </details>
    </div>
  </details>
}
