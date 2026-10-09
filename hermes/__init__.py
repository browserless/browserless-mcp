from .provider import BrowserlessBrowserProvider


def register(ctx) -> None:
    ctx.register_browser_provider(BrowserlessBrowserProvider())
