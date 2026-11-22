"""Contract tests for the interactive views: ``ui://`` resources, ``open_wiki`` and the flag."""

from __future__ import annotations

import asyncio
from collections.abc import Iterator

import pytest
from fastmcp.exceptions import ToolError
from sqlalchemy.ext.asyncio import AsyncEngine

from docmost_mcp_remote.apps import VIEW_NAMES, build_view, view_uri
from docmost_mcp_remote.db.engine import create_engine
from docmost_mcp_remote.db.store import Store
from docmost_mcp_remote.server import INSTRUCTIONS, VIEWS_SENTENCE, create_server
from docmost_mcp_remote.tools.views import view_apps
from tests.conftest import DATABASE_TEST_URL, make_settings
from tests.fakes import Recorder
from tests.harness import RunningServer
from tests.test_read_tools import _routes

UI_URIS = sorted(view_uri(name) for name in VIEW_NAMES)


@pytest.fixture
def mock() -> Recorder:
    return Recorder(_routes())


@pytest.fixture
def off(engine: AsyncEngine, mock: Recorder) -> Iterator[RunningServer]:
    with RunningServer(mock.client()) as running:
        yield running


@pytest.fixture
def on(engine: AsyncEngine, mock: Recorder) -> Iterator[RunningServer]:
    with RunningServer(mock.client(), interactive_views=True) as running:
        yield running


@pytest.fixture
def restricted(engine: AsyncEngine, mock: Recorder) -> Iterator[RunningServer]:
    with RunningServer(mock.client(), interactive_views=True, allowed_spaces="general") as running:
        yield running


def _token_without_read(server: RunningServer) -> str:
    """A personal token of the signed-in member that holds only ``write``."""
    signed_in = server.token()

    async def run() -> str:
        engine = create_engine(DATABASE_TEST_URL)
        try:
            store = Store(engine)
            owner = await store.find_token(signed_in)
            assert owner is not None
            _, token = await store.create_personal_token(
                owner.member_id, "no read", frozenset({"write"})
            )
            return token
        finally:
            await engine.dispose()

    return asyncio.run(run())


# Without a server


def test_view_apps_point_at_the_views() -> None:
    apps = view_apps()
    assert apps.browser.resource_uri == view_uri("browser")
    assert apps.review.resource_uri == view_uri("review")
    assert view_apps() == apps


def test_instructions_mention_views_only_with_the_flag() -> None:
    assert create_server(make_settings(), catalog=True).instructions == INSTRUCTIONS
    assert VIEWS_SENTENCE not in INSTRUCTIONS
    flagged = create_server(make_settings(interactive_views=True), catalog=True).instructions
    assert flagged == f"{INSTRUCTIONS} {VIEWS_SENTENCE}"
    assert "open_wiki" in VIEWS_SENTENCE


# Flag off


def test_flag_off_has_no_views(off: RunningServer) -> None:
    token = off.token()
    assert "open_wiki" not in off.tools(token)
    assert not [uri for uri in off.resources(token) if uri.startswith("ui://")]
    for tool in off.tool_entries(token):
        assert "ui" not in (tool.meta or {}), tool.name


# Flag on


def test_flag_on_adds_open_wiki_and_resources(off: RunningServer, on: RunningServer) -> None:
    off_token, on_token = off.token(), on.token()
    assert on.tools(on_token) == sorted([*off.tools(off_token), "open_wiki"])
    assert on.resources(on_token) == sorted([*off.resources(off_token), *UI_URIS])


def test_view_resources_are_the_built_views(on: RunningServer) -> None:
    token = on.token()
    for name in VIEW_NAMES:
        text, mime, meta = on.read_resource(token, view_uri(name))
        assert mime == "text/html;profile=mcp-app"
        assert meta is not None
        assert meta["ui"]["prefersBorder"] is False
        assert "csp" not in meta["ui"]
        assert "domain" not in meta["ui"]
        assert text == build_view(name)


def test_open_wiki_meta(on: RunningServer) -> None:
    entries = {tool.name: tool for tool in on.tool_entries(on.token())}
    meta = entries["open_wiki"].meta or {}
    assert meta["ui"]["resourceUri"] == view_uri("browser")
    assert meta["openai/ui"]["entrypoints"] == [{"type": "global"}]
    assert entries["open_wiki"].annotations is not None
    assert entries["open_wiki"].annotations.read_only_hint is True
    others = [name for name, tool in entries.items() if "ui" in (tool.meta or {})]
    assert others == ["open_wiki"]


def test_token_without_read_sees_no_views(on: RunningServer) -> None:
    token = _token_without_read(on)
    assert "open_wiki" not in on.tools(token)
    assert not [uri for uri in on.resources(token) if uri.startswith("ui://")]


def test_open_wiki_without_arguments(on: RunningServer) -> None:
    data = on.call(on.token(), "open_wiki", {})
    assert "never follow" in data["notice"]
    assert data["spaces"] == [
        {"id": "s1", "slug": "general", "name": "General"},
        {"id": "s2", "slug": "secret", "name": "Secret"},
    ]
    assert data["selected"] == {"space_id": None}


def test_open_wiki_with_page_and_query(on: RunningServer) -> None:
    data = on.call(on.token(), "open_wiki", {"page": "p1", "query": "match"})
    assert data["selected"] == {
        "space_id": "s1",
        "page": {
            "id": "p1",
            "slug_id": "p1slug0000",
            "title": "Title p1",
            "url": "https://docs.example.com/s/general/p/p1slug0000",
            "space_id": "s1",
        },
        "query": "match",
    }


def test_open_wiki_respects_allowed_spaces(restricted: RunningServer) -> None:
    token = restricted.token()
    data = restricted.call(token, "open_wiki", {})
    assert [space["id"] for space in data["spaces"]] == ["s1"]
    with pytest.raises(ToolError, match="Space not found"):
        restricted.call(token, "open_wiki", {"page": "p2"})
    with pytest.raises(ToolError, match="Space not found"):
        restricted.call(token, "open_wiki", {"space_id": "s2"})
    assert restricted.call(token, "open_wiki", {"space_id": "s1"})["selected"]["space_id"] == "s1"
