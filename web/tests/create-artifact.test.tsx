import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CreateArtifactForm from "../components/create-artifact-form";

const apiBaseUrl = "https://pearlhub-api.example.test";
const testToken = "temporary-test-token";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function artifactResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "artifact-123",
    ownerId: "owner-456",
    name: "Example Pearl",
    slug: "example-pearl",
    visibility: "public",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetch(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) =>
    handler(new URL(input instanceof Request ? input.url : String(input)), init));
  vi.stubGlobal("fetch", mock);
  vi.stubEnv("NEXT_PUBLIC_PEARLHUB_API_BASE_URL", apiBaseUrl);
  return mock;
}

function fillRequiredFields() {
  fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "  Example Pearl  " } });
  fireEvent.change(screen.getByLabelText(/^Slug/), { target: { value: "example-pearl" } });
  fireEvent.change(screen.getByLabelText(/^Developer bearer token/), { target: { value: testToken } });
}

describe("Create Artifact form", () => {
  it("renders labelled required fields and exactly the visibility values supported by the API", () => {
    render(<CreateArtifactForm />);

    expect(screen.getByRole("heading", { name: "Create an Artifact" })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Name/)).toBeRequired();
    expect(screen.getByLabelText(/^Slug/)).toBeRequired();
    expect(screen.getByLabelText(/^Visibility/)).toBeRequired();
    expect(screen.getByLabelText(/^Developer bearer token/)).toHaveAttribute("type", "password");
    expect(screen.getByLabelText(/^Visibility/).querySelectorAll("option")).toHaveLength(3);
    expect(screen.getByRole("link", { name: "Back to discovery" })).toHaveAttribute("href", "/");
    expect(screen.getByText(/not a login system/i)).toBeInTheDocument();
  });

  it("prevents invalid and missing fields from being submitted and focuses validation feedback", () => {
    const mock = installFetch(() => jsonResponse(artifactResponse()));
    render(<CreateArtifactForm />);

    fireEvent.click(screen.getByRole("button", { name: "Create Artifact" }));
    expect(screen.getByText("Enter an Artifact name.")).toBeInTheDocument();
    expect(screen.getByText("Enter an Artifact slug.")).toBeInTheDocument();
    expect(screen.getByText("Enter a valid bearer token to create an Artifact.")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Name/)).toHaveFocus();
    expect(mock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "x".repeat(201) } });
    fireEvent.change(screen.getByLabelText(/^Slug/), { target: { value: "Invalid Slug" } });
    fireEvent.change(screen.getByLabelText(/^Developer bearer token/), { target: { value: testToken } });
    fireEvent.click(screen.getByRole("button", { name: "Create Artifact" }));
    expect(screen.getByText("Artifact names can be up to 200 characters.")).toBeInTheDocument();
    expect(screen.getByText("Use lowercase letters, numbers, and single hyphens only.")).toBeInTheDocument();
    expect(mock).not.toHaveBeenCalled();
  });

  it("posts exactly the supported fields to the configured API and displays only confirmed response data", async () => {
    const mock = installFetch(() => jsonResponse(artifactResponse()));
    const localStorageSet = vi.spyOn(window.localStorage, "setItem");
    const sessionStorageSet = vi.spyOn(window.sessionStorage, "setItem");
    render(<CreateArtifactForm />);
    fillRequiredFields();
    fireEvent.change(screen.getByLabelText(/^Visibility/), { target: { value: "public" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Artifact" }));

    expect(await screen.findByRole("heading", { name: "Artifact created successfully" })).toBeInTheDocument();
    const [requestInput, requestInit = {}] = mock.mock.calls[0]!;
    const requestUrl = new URL(requestInput instanceof Request ? requestInput.url : String(requestInput));
    expect(requestUrl.origin).toBe(apiBaseUrl);
    expect(requestUrl.pathname).toBe("/api/v1/artifacts");
    expect(requestUrl.search).toBe("");
    expect(requestInit.method).toBe("POST");
    expect(requestInit.redirect).toBe("error");
    expect(new Headers(requestInit.headers).get("content-type")).toBe("application/json");
    expect(new Headers(requestInit.headers).get("authorization")).toBe(`Bearer ${testToken}`);
    expect(JSON.parse(String(requestInit.body))).toEqual({
      name: "Example Pearl",
      slug: "example-pearl",
      visibility: "public",
    });
    expect(String(requestUrl)).not.toContain(testToken);
    expect(screen.getByText("artifact-123")).toBeInTheDocument();
    expect(screen.queryByText("owner-456")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create another Artifact" })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Developer bearer token/)).toHaveValue("");
    expect(localStorageSet).not.toHaveBeenCalled();
    expect(sessionStorageSet).not.toHaveBeenCalled();
  });

  it("prevents a duplicate submission while the API request is pending", async () => {
    let resolveRequest: ((response: Response) => void) | undefined;
    const mock = installFetch(() => new Promise<Response>((resolve) => {
      resolveRequest = resolve;
    }));
    render(<CreateArtifactForm />);
    fillRequiredFields();
    const submitButton = screen.getByRole("button", { name: "Create Artifact" });
    fireEvent.click(submitButton);

    expect(await screen.findByRole("button", { name: "Creating Artifact…" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("button", { name: "Creating Artifact…" }).closest("form")!);
    expect(mock).toHaveBeenCalledTimes(1);

    await act(async () => resolveRequest?.(jsonResponse(artifactResponse())));
    expect(await screen.findByRole("heading", { name: "Artifact created successfully" })).toBeInTheDocument();
  });

  it("shows API validation errors accessibly and preserves entered values", async () => {
    installFetch(() => jsonResponse({
      error: {
        code: "INVALID_REQUEST",
        message: "Artifact slug is invalid.",
        details: { field: "slug" },
      },
    }, 400));
    render(<CreateArtifactForm />);
    fillRequiredFields();
    fireEvent.click(screen.getByRole("button", { name: "Create Artifact" }));

    const slug = screen.getByLabelText(/^Slug/);
    await waitFor(() => expect(slug).toHaveAttribute("aria-invalid", "true"));
    expect(screen.getByText("Artifact slug is invalid.")).toHaveAttribute("id", "artifact-slug-error");
    expect(slug).toHaveAttribute("aria-describedby", "artifact-slug-error");
    expect(slug).toHaveValue("example-pearl");
    expect(screen.getByLabelText(/^Name/)).toHaveValue("  Example Pearl  ");
    expect(screen.getByLabelText(/^Developer bearer token/)).toHaveValue(testToken);
    expect(screen.queryByRole("heading", { name: "Artifact created successfully" })).not.toBeInTheDocument();
  });

  it.each([
    [401, "Authentication failed. Enter a valid bearer token issued for the PearlHub API."],
    [409, "Artifact slug already belongs to this owner."],
    [500, "The API could not create this Artifact (HTTP 500). Please try again."],
  ])("handles HTTP %s without claiming success and keeps form values", async (status, expectedMessage) => {
    installFetch(() => jsonResponse({
      error: {
        code: "ERROR",
        message: status === 409 ? expectedMessage : "private internal details",
        details: {},
      },
    }, status));
    render(<CreateArtifactForm />);
    fillRequiredFields();
    fireEvent.click(screen.getByRole("button", { name: "Create Artifact" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(expectedMessage);
    expect(screen.queryByRole("heading", { name: "Artifact created successfully" })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^Name/)).toHaveValue("  Example Pearl  ");
    expect(screen.getByLabelText(/^Slug/)).toHaveValue("example-pearl");
    if (status === 500) expect(screen.queryByText("private internal details")).not.toBeInTheDocument();
  });

  it("shows safe network and unexpected-response errors without losing the form", async () => {
    const mock = installFetch(() => jsonResponse(artifactResponse({ ownerId: 42 })));
    render(<CreateArtifactForm />);
    fillRequiredFields();
    fireEvent.click(screen.getByRole("button", { name: "Create Artifact" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The API returned an unexpected response.");
    expect(screen.queryByRole("heading", { name: "Artifact created successfully" })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^Name/)).toHaveValue("  Example Pearl  ");

    mock.mockRejectedValueOnce(new TypeError(`request failed with ${testToken}`));
    fireEvent.click(screen.getByRole("button", { name: "Create Artifact" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not reach the PearlHub API. Check your connection and try again.",
    );
    expect(screen.queryByText(testToken)).not.toBeInTheDocument();
  });
});
