"""Validate local fixture connections and never forward their bearer on redirect."""
import urllib.parse
import urllib.request


def validate_connection(connection):
    url = connection["url"]
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port
            or parsed.username is not None or parsed.password is not None
            or parsed.path or parsed.query or parsed.fragment
            or url != f"http://127.0.0.1:{parsed.port}"):
        raise ValueError("Expected an exact local Sift connection URL")
    if not isinstance(connection.get("token"), str) or not connection["token"]:
        raise ValueError("Missing local Sift connection token")
    return connection


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        raise ValueError("Local Sift API redirects are not allowed")


def open_local(connection, path, *, data=None, method=None, timeout=90, headers=None, auth=True):
    validate_connection(connection)
    if not path.startswith("/") or path.startswith("//"):
        raise ValueError("Expected a local absolute API path")
    request_headers = {"X-Sift-Request": "1"}
    if auth:
        request_headers["Authorization"] = "Bearer " + connection["token"]
    request_headers.update(headers or {})
    request = urllib.request.Request(connection["url"] + path, data=data, method=method, headers=request_headers)
    return urllib.request.build_opener(NoRedirects()).open(request, timeout=timeout)
