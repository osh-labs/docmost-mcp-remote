"""Interactive views (MCP Apps): the ``ui://`` resources and the tools that open them.

Registered only when ``INTERACTIVE_VIEWS`` is on. A view is a self-contained HTML
page with no member data; it fetches what it shows by calling read tools as the
member. The ``open_*`` tools return the same data to clients that show no views.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated, Any

from fastmcp import FastMCP
from fastmcp.apps import UI_MIME_TYPE, AppConfig
from fastmcp.exceptions import ToolError
from fastmcp.server.auth import require_scopes
from fastmcp.tools import FunctionTool
from pydantic import Field

from docmost_mcp_remote.apps import VIEW_NAMES, build_view, view_uri
from docmost_mcp_remote.config import Settings
from docmost_mcp_remote.docmost import DocmostBackend
from docmost_mcp_remote.members import MemberService
from docmost_mcp_remote.tools.common import as_member, page_link
from docmost_mcp_remote.tools.read import page_ref
from docmost_mcp_remote.tools.spaces import SpacePolicy
from docmost_mcp_remote.tools.untrusted import NOTICE

_READ_ONLY = {"readOnlyHint": True, "openWorldHint": False}
#: Pages of 100 spaces ``open_wiki`` reads at most.
_MAX_SPACE_PAGES = 20
#: Lets ChatGPT offer the wiki browser outside a single answer.
_GLOBAL_ENTRYPOINT = {"openai/ui": {"entrypoints": [{"type": "global"}]}}


@dataclass(frozen=True)
class ViewApps:
    """The app configuration a tool passes as ``app=`` to open each view."""

    browser: AppConfig
    review: AppConfig


def view_apps() -> ViewApps:
    """The tool-side app configuration of each view. Registers nothing."""
    return ViewApps(
        browser=AppConfig(resource_uri=view_uri("browser")),
        review=AppConfig(resource_uri=view_uri("review")),
    )


def _register_resource(mcp: FastMCP, name: str) -> None:
    html = build_view(name)

    @mcp.resource(
        view_uri(name),
        name=f"{name}_view",
        description=f"The interactive {name} view (an MCP App page). It holds no wiki data.",
        mime_type=UI_MIME_TYPE,
        app=AppConfig(prefers_border=False),
        auth=require_scopes("read"),
    )
    def view() -> str:
        return html


def register(mcp: FastMCP, settings: Settings, members: MemberService) -> ViewApps:
    """Add the ``ui://`` resources and the ``open_*`` tools; return the views' app configs."""
    policy = SpacePolicy(settings.allowed_spaces)
    docmost_base = str(settings.docmost_url).rstrip("/")
    apps = view_apps()

    for name in VIEW_NAMES:
        _register_resource(mcp, name)

    @mcp.tool(
        name="open_wiki",
        title="Docmost wiki",
        description=(
            "Open an interactive wiki browser for the spaces and pages you can access, where "
            "the client can show one. Clients that show only text get the same list of "
            "spaces, and the page or search asked for. All arguments are optional."
        ),
        annotations=_READ_ONLY,
        auth=require_scopes("read"),
        app=apps.browser,
        meta=_GLOBAL_ENTRYPOINT,
    )
    async def open_wiki(
        space_id: Annotated[
            str | None, Field(description="Space id from list_spaces to open first.")
        ] = None,
        page: Annotated[
            str | None, Field(description="Page id, slug id or Docmost page URL to open.")
        ] = None,
        query: Annotated[str | None, Field(description="Search to start with.")] = None,
    ) -> dict[str, Any]:
        async def action(backend: DocmostBackend) -> dict[str, Any]:
            spaces: list[dict[str, Any]] = []
            cursor: str | None = None
            for _ in range(_MAX_SPACE_PAGES):
                found = await backend.list_spaces(cursor=cursor, limit=100)
                spaces.extend(
                    {"id": space.id, "slug": space.slug, "name": space.name}
                    for space in found.items
                    if policy.allows_space(space)
                )
                if not found.has_next_page or not found.next_cursor:
                    break
                cursor = found.next_cursor
            selected: dict[str, Any] = {"space_id": space_id}
            if space_id:
                await policy.check(backend, space_id)
            if page:
                target = await backend.get_page(page_ref(page))
                await policy.check(backend, target.space_id)
                selected["page"] = {
                    "id": target.id,
                    "slug_id": target.slug_id,
                    "title": target.title or "(untitled)",
                    "url": page_link(docmost_base, target),
                    "space_id": target.space_id,
                }
                if not space_id:
                    selected["space_id"] = target.space_id
            if query:
                selected["query"] = query
            return {"notice": NOTICE, "spaces": spaces, "selected": selected}

        return await as_member(members, action)

    @mcp.tool(
        name="open_page_history",
        title="Page history",
        description=(
            "Open an interactive view of a page's saved versions, where the client can show "
            "one, to compare them with diff_page. Clients that show only text get the page "
            "and the same version list as list_page_history."
        ),
        annotations=_READ_ONLY,
        auth=require_scopes("read"),
        app=apps.review,
    )
    async def open_page_history(
        page: Annotated[str, Field(description="Page id, slug id or Docmost page URL.")],
    ) -> dict[str, Any]:
        async def action(backend: DocmostBackend) -> dict[str, Any]:
            target = await backend.get_page(page_ref(page))
            await policy.check(backend, target.space_id)
            return {
                "id": target.id,
                "slug_id": target.slug_id,
                "title": target.title or "(untitled)",
                "url": page_link(docmost_base, target),
                "space_id": target.space_id,
            }

        found = await as_member(members, action)
        # The listing is list_page_history's own, so both tools give the same result.
        listing = await mcp.local_provider.get_tool("list_page_history")
        if not isinstance(listing, FunctionTool):
            raise ToolError("Page history is not available.")
        history: dict[str, Any] = await listing.fn(page=found["id"], cursor=None, limit=20)
        return {"notice": NOTICE, "page": found, "history": history}

    return apps
