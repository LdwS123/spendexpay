import { parseProviderError, ProviderError } from "./provider-error.js";
import { withRetry } from "./retry.js";

const MODAL_API_BASE = "https://api.modal.com/v1";

interface RunModalFunctionParams {
  appName: string;        // Modal app name (e.g. "my-app")
  functionName: string;   // Function within the app (e.g. "run_inference")
  inputJson?: string;     // Optional JSON input to pass to the function
  modalToken: string;     // Modal API token
}

interface ModalRunResult {
  callId: string;
  outputSummary: string;
  url: string;
}

export async function runModalFunction(
  params: RunModalFunctionParams
): Promise<ModalRunResult> {
  const { appName, functionName, inputJson, modalToken } = params;

  let parsedInput: unknown = {};
  if (inputJson !== undefined) {
    try {
      parsedInput = JSON.parse(inputJson);
    } catch {
      throw new ProviderError(
        "unknown",
        "inputJson is not valid JSON.",
        "modal"
      );
    }
  }

  let response: Response;
  try {
    response = await withRetry(() =>
      fetch(`${MODAL_API_BASE}/apps/${appName}/functions/${functionName}/call`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${modalToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ input: parsedInput }),
      })
    );
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(
      "network",
      "Could not reach Modal. Check your internet connection and try again.",
      "modal"
    );
  }

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new ProviderError(
        "auth",
        "Your Modal token is invalid or expired. Generate a new one at modal.com/settings and update it in your Spendex dashboard.",
        "modal",
        response.status
      );
    }
    throw parseProviderError(response.status, body, "modal");
  }

  const data = (await response.json()) as { call_id: string };

  return {
    callId: data.call_id,
    outputSummary: "Function queued — check the Modal dashboard for output.",
    url: "https://modal.com/apps/" + appName,
  };
}
