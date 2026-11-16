#!/usr/bin/env python3
"""CF-Ghproxy 自检脚本（无第三方依赖）。

用法：
    python3 test/smoke.py https://gh.example.com

覆盖：源码包下载、raw、/blob/ 转 raw、API 对象响应、API 分页头改写、Range、HEAD、
release 附件（自动从 API 里挑最小的一个）、首页回退、?q= 跳转、OPTIONS 预检。
"""
import json
import os
import sys
import urllib.error
import urllib.request
import zipfile
import io

OWNER_REPO = "KuwiNet/CF-Ghproxy"
UA = "curl/8.7.1"
PASSED = []
FAILED = []


def header(headers, name):
    for k, v in headers.items():
        if k.lower() == name.lower():
            return v
    return None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """不让 urllib 自动跟随 3xx（本脚本要检查跳转本身）。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def request(base, path, headers=None, method="GET"):
    h = {"User-Agent": UA}
    if headers:
        h.update(headers)
    req = urllib.request.Request(base + path, headers=h, method=method)
    try:
        with OPENER.open(req, timeout=120) as resp:
            return resp.status, resp.headers, resp.read()
    except urllib.error.HTTPError as err:
        return err.code, err.headers, err.read()
    except Exception as err:  # noqa: BLE001
        return None, {}, str(err).encode()


def check(name, ok, detail=""):
    (PASSED if ok else FAILED).append((name, detail))
    print(("PASS  " if ok else "FAIL  ") + name + ("   " + detail if detail else ""))


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    base = sys.argv[1].rstrip("/")

    # 1. 仓库源码包
    path = "/https://github.com/%s/archive/refs/heads/main.zip" % OWNER_REPO
    status, headers, body = request(base, path)
    ok = status == 200 and bool(body)
    names = []
    try:
        with zipfile.ZipFile(io.BytesIO(body)) as zf:
            names = zf.namelist()
    except Exception:  # noqa: BLE001
        ok = False
    check("archive zip 完整", ok and bool(names), "status=%s bytes=%d files=%d" % (status, len(body), len(names)))

    # 2. raw 文件
    status, headers, raw = request(base, "/https://raw.githubusercontent.com/%s/main/readme.md" % OWNER_REPO)
    check("raw 文件", status == 200 and len(raw) > 0, "status=%s bytes=%d" % (status, len(raw)))

    # 3. /blob/ 自动转 raw
    status, headers, blob = request(base, "/https://github.com/%s/blob/main/readme.md" % OWNER_REPO)
    check("/blob/ 转 raw", status == 200 and blob == raw, "status=%s bytes=%d" % (status, len(blob)))

    # 4. API 对象响应（原实现里同类接口会 502）
    status, headers, body = request(base, "/https://api.github.com/repos/%s" % OWNER_REPO)
    ok = status == 200 and json.loads(body).get("full_name") == OWNER_REPO
    check("API 对象响应", ok, "status=%s" % status)

    # 5. API 分页 Link 头改写（设置了 PUBLIC_HOST 时应指向对外域名）
    status, headers, _ = request(base, "/https://api.github.com/users/KuwiNet/repos?per_page=2")
    link = header(headers, "link") or ""
    public = (os.environ.get("PUBLIC_HOST") or "").strip().replace("https://", "").replace("http://", "")
    expect_base = ("https://" + public) if public else base
    check("API 分页 Link 改写", status == 200 and ("<" + expect_base) in link,
          "status=%s expect=%s link=%s" % (status, expect_base, link[:120]))

    # 6. Range / HEAD
    status, headers, body = request(base, "/https://raw.githubusercontent.com/%s/main/readme.md" % OWNER_REPO,
                                    {"Range": "bytes=0-199"})
    check("Range 206", status == 206 and len(body) == 200, "status=%s bytes=%d" % (status, len(body)))
    status, headers, _ = request(base, "/https://raw.githubusercontent.com/%s/main/readme.md" % OWNER_REPO, method="HEAD")
    check("HEAD", status == 200 and header(headers, "content-length") is not None,
          "status=%s len=%s" % (status, header(headers, "content-length")))

    # 7. release 附件（自动挑最小的）
    status, headers, body = request(base, "/https://api.github.com/repos/%s/releases?per_page=3" % OWNER_REPO)
    assets = []
    if status == 200:
        for rel in json.loads(body):
            for asset in rel.get("assets", []):
                assets.append((asset.get("size", 0), asset["browser_download_url"]))
    if assets:
        size, url = sorted(assets)[0]
        path = "/" + url
        status, headers, _ = request(base, path, method="HEAD")
        check("release 附件 HEAD", status == 200 and header(headers, "content-length") == str(size),
              "status=%s len=%s expect=%d" % (status, header(headers, "content-length"), size))
        if size and size <= 16 * 1024 * 1024:
            status, headers, data = request(base, path)
            check("release 附件下载", status == 200 and len(data) == size and header(headers, "content-disposition"),
                  "status=%s bytes=%d/%d" % (status, len(data), size))
        else:
            print("SKIP  release 附件整包下载（最小附件 %d 字节，过大）" % size)
    else:
        print("SKIP  release 附件（仓库没有发布带附件的 release）")

    # 8. 首页回退 / 跳转 / 预检
    status, headers, body = request(base, "/")
    check("首页回退", status == 200 and len(body) > 0, "status=%s bytes=%d" % (status, len(body)))
    status, headers, _ = request(base, "/?q=https://github.com/%s/archive/refs/heads/main.zip" % OWNER_REPO)
    check("?q= 301", status == 301 and header(headers, "location"), "status=%s" % status)
    status, headers, _ = request(base, "/", {"Access-Control-Request-Method": "GET",
                                             "Access-Control-Request-Headers": "authorization",
                                             "Origin": "https://example.com"}, method="OPTIONS")
    check("OPTIONS 预检", status == 204, "status=%s" % status)
    status, headers, body = request(base, "/_health")
    check("/_health", status == 200 and b'"status"' in body, "status=%s" % status)

    print("\n%d passed, %d failed" % (len(PASSED), len(FAILED)))
    for name, detail in FAILED:
        print("  FAILED: %s %s" % (name, detail))
    return 0 if not FAILED else 1


if __name__ == "__main__":
    sys.exit(main())
