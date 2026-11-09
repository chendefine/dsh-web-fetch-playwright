/**
 * The denoise pipeline against representative fixture pages: a docs-style
 * article wrapped in nav/sidebar/footer/ads chrome, a table page, a
 * non-article page that must fall back to whole-document conversion,
 * list-shaped pages (portal/catalog) where Readability's link-density
 * scoring picks a noise fragment and the coverage gate must distrust it,
 * and article pages whose extraction rides in a post-article
 * recommendation rail (the 163.com dy-article badcase) that only the
 * trailing link-dense prune can strip — plus the no-false-positive control
 * for that prune.
 */
import { describe, expect, it } from 'vitest'
import { htmlToMarkdown } from '../src/markdown.ts'

/** A typical docs/blog page: header nav, sidebar, article, footer, ad slots. */
const ARTICLE_PAGE = `<!doctype html>
<html><head><title>Playwright guide</title><style>.x{color:red}</style></head>
<body>
<nav><a href="/">Home</a> <a href="/docs">Docs</a> <a href="/blog">Blog</a></nav>
<aside id="sidebar"><div>Related</div><ul><li><a href="/a">link one</a></li><li><a href="/b">link two</a></li></ul></aside>
<main>
<article>
<h1>Getting started</h1>
<p>Playwright enables reliable end-to-end testing of modern web apps. It works across all major browsers, runs headless or headed, and captures traces for every run.</p>
<h2>Installation</h2>
<p>Install with <code>npm i playwright</code>, then run <code>playwright install</code> once to download the browser binaries the library drives.</p>
<ul><li>Auto-wait for elements</li><li>Network interception</li><li>Multi-browser contexts</li></ul>
<p>See the <a href="https://example.com/docs">full documentation</a> for details.</p>
</article>
</main>
<div class="ad banner-ad"><a href="/buy">BUY NOW — 50% OFF</a></div>
<footer><nav><a href="/tos">Terms</a> <a href="/privacy">Privacy</a></nav>© 2026 Example Corp</footer>
<script>window.tracker = { send: () => {} }</script>
</body></html>`

/** A page whose payload is one GFM table. */
const TABLE_PAGE = `<!doctype html>
<html><head><title>Servers</title></head><body>
<nav>global nav noise</nav>
<main>
<h1>Servers</h1>
<p>Two server regions are currently online and accepting traffic from the control plane.</p>
<table>
<thead><tr><th>Name</th><th>Region</th></tr></thead>
<tbody>
<tr><td>alpha</td><td>cn-north</td></tr>
<tr><td>beta</td><td>us-east</td></tr>
</tbody>
</table>
</main>
<footer>footer noise</footer>
</body></html>`

/** A page with no article structure at all (login-like). */
const NON_ARTICLE_PAGE = `<!doctype html>
<html><head><title>Login</title></head><body>
<nav>nav noise</nav>
<main><h1>Login</h1><form><input name="user"><input name="pass" type="password"><button>Sign in</button></form><p>Session expired, please sign in again. Enter your credentials to continue where you left off.</p></main>
<footer>footer noise</footer>
</body></html>`

/** A build-tool-inlined data URI payload (4096 base64 chars = 3072 bytes). */
const DATA_URI_3KB = `data:image/png;base64,${'A'.repeat(4096)}`
/** A docs article whose build tool inlined its screenshots as data URIs. */
const INLINE_IMAGE_PAGE = `<!doctype html>
<html><head><title>Inline images</title></head><body>
<nav>nav noise</nav>
<main><article>
<h1>Guide</h1>
<p>Intro paragraph with enough text for extraction to latch onto the article region.</p>
<p><img decoding=async loading=lazy alt="tiny chart" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="></p>
<p><img alt="big screenshot" title="The screenshot" src="${DATA_URI_3KB}"></p>
<p><img alt="remote photo" src="https://example.com/photo.png"></p>
</article></main>
<footer>footer noise</footer>
</body></html>`

/**
 * A portal homepage (the 163.com badcase shape, minimized): every column is
 * short link-dense list items the scorer refuses to score (under 25 chars
 * each) with list-tag penalties on top, so the only candidate Readability
 * can credit is the low-link-density licensing block in the corner — 95
 * characters that used to become the whole fetch result.
 */
const PORTAL_HEADLINES = Array.from(
  { length: 70 },
  (_, i) => `<li><a href="/n/${i + 1}">第${i + 1}条中超冠军属于大连英博队</a></li>`,
)
const PORTAL_PAGE = `<!doctype html>
<html><head><title>门户首页</title></head><body>
<nav>新闻 体育 财经 科技 娱乐 汽车</nav>
<div class="wrap">
<div class="col"><h2>新闻</h2><ul>${PORTAL_HEADLINES.slice(0, 35).join('')}</ul></div>
<div class="col"><h2>体育</h2><ul>${PORTAL_HEADLINES.slice(35).join('')}</ul></div>
</div>
<div class="subfoot_zbdw"><p>工业和信息化部备案管理系统网站 粤B2-20090191-18</p><p>主办单位：广州某计算机系统有限公司</p><p>Operated by Guangzhou Example Computer System Co., Ltd.</p></div>
</body></html>`

/**
 * A channel page with an editorial preamble (the sina.com.cn badcase shape):
 * the 480-character link-free block is long enough to clear the absolute
 * floor but covers under a tenth of the 5.2k visible characters, so the
 * coverage ratio — not the length check — must reject it.
 */
const CHANNEL_EDITORIAL = Array.from(
  { length: 3 },
  () => '<p>这是一段没有任何链接的编辑导语文字，用来模拟频道页顶部的编辑荐读区域。它必须足够长以便 Readability 把它当作最佳候选，同时相对整页只占很小的比例，从而触发覆盖率判定而不是绝对字数判定。这段文字还需要超过两百五十个字符的长度，因此在这里继续补充关于覆盖率门设计动机的说明文字，确保长度条件被稳定满足而不依赖边界值。</p>',
)
const CHANNEL_ITEMS = Array.from(
  { length: 160 },
  (_, i) => `<li><a href="/c/${i + 1}">频道列表第${i + 1}条标题某地发布最新政策引发广泛关注与讨论${i + 1}</a></li>`,
)
const CHANNEL_PAGE = `<!doctype html>
<html><head><title>频道页</title></head><body>
<nav>频道导航词</nav>
<div class="editorial">${CHANNEL_EDITORIAL.join('')}</div>
<div class="list"><ul>${CHANNEL_ITEMS.join('')}</ul></div>
</body></html>`

/**
 * A text-rich article page (the no-false-demotion control): well over a
 * thousand visible characters, the article covering the vast majority of
 * them, so the coverage gate must accept the extraction untouched.
 */
const RICH_ARTICLE_PARAGRAPHS = [
  'Structured concurrency gives every fetch a deadline that propagates through the whole call tree, so a slow subrequest cannot quietly outlive the navigation that spawned it.',
  'The pool hands out leases rather than bare browsers: a lease owns one tab inside a shared context, and releasing it closes exactly that tab even when the surrounding context stays warm for the next caller.',
  'Timeouts are budgets, not alarms. Each stage of a fetch reserves a slice of the total deadline, and a stage that runs long shrinks the slices that follow instead of silently borrowing from the caller.',
  'Recovery paths matter as much as happy paths: a navigation that fails because the browser declined to render the response is turned back into a result carrying the tracked status code.',
  'Concurrency limits price the expensive resource, not the request: local slots are whole browsers, remote slots are tabs in a browser that already exists, and queue wait is bounded so callers fail fast.',
  'Every layer is observable: the tracker records the last main-frame response, the pool records lease lifetimes, and the denoise pipeline reports which extraction path produced the markdown.',
]
const RICH_ARTICLE_PAGE = `<!doctype html>
<html><head><title>Browsers as a fetch backend</title></head><body>
<nav>nav noise</nav>
<main><article>
<h1>Browsers as a fetch backend</h1>
${RICH_ARTICLE_PARAGRAPHS.map(p => `<p>${p}</p>`).join('\n')}
</article></main>
<div class="ad banner-ad">LIMITED TIME — upgrade today and save fifty percent on the annual plan, offer ends Sunday</div>
<footer>footer noise</footer>
</body></html>`

/**
 * A dy-article page (the 163.com article badcase shape, minimized from the
 * live page): the article wrapper Readability scores as the winner carries
 * not just the body but the platform disclaimer and a recommendation rail
 * of image/title/author/date cards. The rail's per-card link density
 * (title-only links over title+author+date text, ~0.42–0.48) sits just
 * under Readability's own "mostly links" removal bar (0.5), so every card
 * survives its cleaning pass — measured on the live page the rail holds 84
 * linked characters inside 183 (0.46) and dominated 60% of the returned
 * markdown. Class vocabulary cannot rescue this later either: the extracted
 * rail is bare-div markup, and `recommend` is absent from Readability's
 * unlikely/negative regexes regardless.
 */
const REC_CARDS = [
  ['轰动NBA！你好湖人！曝浓眉哥或施压交易离队', '篮球实战宝典', '2026-11-08 17:34:43'],
  ['黄仁勋情人所属的Megaspeed公司什么背景', '修明札记', '2026-11-09 15:52:29'],
  ['巅峰下滑！现在的约基奇值5年37亿吗', '篮球实录', '2026-11-09 17:11:58'],
  ['就在今天詹姆斯刷新了3个NBA历史纪录', '篮球大视野', '2026-11-09 08:01:25'],
] as const
const REC_CARD_HTML = REC_CARDS.map(([title, source, time], index) => `<div class="post_recommend_new"><p><a href="/dy/article/B${String(index + 1)}" title="${title}" class="post_recommend_img"><img src="/thumb${String(index + 1)}.jpg" width="140" height="88" alt="${title}"></a></p><h3><a href="/dy/article/B${String(index + 1)}">${title}</a></h3><p><span class="post_recommend_source">${source}</span></p><p>${time}</p></div>`).join('')
const DY_ARTICLE_RECOMMEND_RAIL = `<div class="post_recommends" data-event="click"><div class="post_recommends_titles"><p>相关推荐</p><p>热点推荐</p></div><div class="post_recommends_ulist">${REC_CARD_HTML}</div></div>`
const DY_ARTICLE_PAGE = `<!doctype html>
<html><head><title>广州最高医疗建筑来了</title></head><body>
<nav>新闻 体育 财经 科技 娱乐 汽车 房产 教育 时尚 手机 数码</nav>
<div class="post_main">
<div class="post_title"><h1>130米！广州最高医疗建筑来了！预计2027年投用</h1></div>
<div class="post_info">2026-11-09 15:38:15　来源: 21世纪经济报道 广东</div>
<div class="post_content" id="contentBody"><div class="post_body" id="content">
<p>广州最高的超高层医疗建筑，中山大学附属第一医院临床研究大楼，近日举行封顶仪式。该项目总建筑面积达5.4万平方米，建筑总高度130米，分为地上29层、地下4层，是目前广州最高的超高层医疗建筑。</p>
<p>该大楼坐落于越秀区中山二路58号院本部，通过拆除后勤楼、行政楼、旧饭堂等老旧楼栋盘活原址土地。项目总占地面积5600平方米，总建筑面积达5.4万平方米，建筑总高度130米，分为地上29层、地下4层，是目前广州最高的超高层医疗建筑，预计2027年年底全面竣工投用。项目建成后将成为集临床研究、成果转化、学术交流于一体的综合性研究平台，为区域医疗资源配置提供新的支撑。</p>
<div class="post_statement"><p>特别声明：以上内容(如有图片或视频亦包括在内)为自媒体平台“网易号”用户上传并发布，本平台仅提供信息存储服务。</p><p>Notice: The content above (including the pictures or videos if any) is uploaded and posted by a user of NetEase Hao, which is a social media platform providing information storage services.</p></div>
${DY_ARTICLE_RECOMMEND_RAIL}
</div></div>
</div>
<ul class="post_recommends_list">${Array.from({ length: 40 }, (_, i) => `<li class="post_recommend"><a href="/r/${String(i)}">第${String(i)}条推荐阅读标题某地发布最新政策引发广泛关注</a></li>`).join('')}</ul>
<footer>关于网易 · 联系我们 · 客户端下载 · 意见反馈</footer>
</body></html>`

/**
 * A sparse auto-trusted page (under the gate's 1,000-character body floor)
 * whose extraction is dominated by the same rail: the trailing prune's
 * dominant-share guard (a block holding over 60% of the article is the
 * scorer's mistake to handle, not the prune's) must keep it untouched —
 * the prune only strips APPENDED widgets, it never guts an extraction.
 */
const SPARSE_ARTICLE_WITH_RAIL = `<!doctype html>
<html><head><title>短讯</title></head><body>
<main><article>
<h1>一句话短讯</h1>
<p>这是一条足够短的正 文，只包含一个段落，用于验证稀疏页面上尾部推荐栏同样会被修剪而不是原样返回。补充一点文字让它像真的短文。</p>
${DY_ARTICLE_RECOMMEND_RAIL}
</article></main>
</body></html>`

/**
 * The no-false-positive control for the trailing prune: a text-rich article
 * whose closing paragraph carries three inline links. Its link density
 * (~0.23) is far under the link-farm bar, and no earlier section is
 * link-dense, so the prune must leave the article byte-intact.
 */
const RICH_ARTICLE_CLOSING_LINKS = `<!doctype html>
<html><head><title>Notes on pools</title></head><body>
<nav>nav noise</nav>
<main><article>
<h1>Notes on pools</h1>
${RICH_ARTICLE_PARAGRAPHS.map(p => `<p>${p}</p>`).join('\n')}
<p>For more on structured concurrency, see the <a href="/a">deadline guide</a>, the <a href="/b">lease design note</a>, and the <a href="/c">timeout taxonomy</a> written by the pool maintainers, each expanding the ideas above with worked diagrams.</p>
</article></main>
<footer>footer noise</footer>
</body></html>`

describe('htmlToMarkdown', () => {
  it('extracts the article and drops nav/sidebar/footer/ad chrome', () => {
    const { markdown, mode } = htmlToMarkdown(ARTICLE_PAGE, 'https://example.com/guide')
    expect(mode).toBe('article')
    // The extracted title leads the markdown (Readability kept the article's
    // own heading structure, so the prepended title is the page <title>).
    expect(markdown).toContain('# Playwright guide')
    expect(markdown).toContain('Getting started')
    expect(markdown).toContain('reliable end-to-end testing')
    expect(markdown).toMatch(/-\s+Auto-wait for elements/)
    expect(markdown).toContain('[full documentation](https://example.com/docs)')
    // Chrome must be gone.
    expect(markdown).not.toContain('Home')
    expect(markdown).not.toContain('Related')
    expect(markdown).not.toContain('BUY NOW')
    expect(markdown).not.toContain('Terms')
    expect(markdown).not.toContain('© 2026')
    expect(markdown).not.toContain('window.tracker')
  })

  it('converts GFM tables with a header separator', () => {
    const { markdown } = htmlToMarkdown(TABLE_PAGE, 'https://example.com/servers')
    expect(markdown).toContain('| Name | Region |')
    expect(markdown).toContain('| --- | --- |')
    expect(markdown).toContain('| alpha | cn-north |')
    expect(markdown).not.toContain('nav noise')
    expect(markdown).not.toContain('footer noise')
  })

  it('extracts the meaningful content of sparse pages (login-like)', () => {
    const { markdown, mode } = htmlToMarkdown(NON_ARTICLE_PAGE, 'https://example.com/login')
    // Readability keeps the meaningful paragraph; the form and chrome go.
    expect(mode).toBe('article')
    expect(markdown).toContain('Session expired')
    expect(markdown).not.toContain('nav noise')
    expect(markdown).not.toContain('footer noise')
    expect(markdown).not.toContain('Sign in')
  })

  it('falls back to whole-document conversion when extraction yields nothing', () => {
    const page = `<!doctype html><html><head><title>Empty-ish</title></head><body>
<nav>nav noise</nav>
<main><p>just one plain line of body text</p></main>
<footer>footer noise</footer>
</body></html>`
    // An empty body is the reliable null-parse shape; the pipeline's fallback
    // is exercised by the pathological-input test below.
    const { mode } = htmlToMarkdown('<html><body></body></html>', 'https://example.com/e')
    expect(mode).toBe('document')
    expect(htmlToMarkdown(page, 'https://example.com/p').markdown).toContain('plain line of body text')
  })

  it('elides inline data-URI image payloads to size placeholders', () => {
    const { markdown, mode } = htmlToMarkdown(INLINE_IMAGE_PAGE, 'https://example.com/guide')
    expect(mode).toBe('article')
    // The base64 payloads are gone entirely...
    expect(markdown).not.toContain('iVBORw0KGgo')
    expect(markdown).not.toContain('A'.repeat(64))
    // ...replaced by alt-bearing, MIME-and-size-marked placeholders; the
    // default image rule's title handling still applies to the short src.
    expect(markdown).toMatch(/!\[tiny chart\]\(data:image\/png;base64,...\d+B\)/)
    expect(markdown).toContain('![big screenshot](data:image/png;base64,...3.0KB "The screenshot")')
    // Remote images are untouched.
    expect(markdown).toContain('![remote photo](https://example.com/photo.png)')
  })

  it('elides data-URI images on the whole-document fallback path too', () => {
    const page = `<!doctype html><html><head><title>Sparse</title></head><body>
<img alt="inline diagram" src="${DATA_URI_3KB}">
</body></html>`
    const { markdown, mode } = htmlToMarkdown(page, 'https://example.com/sparse')
    // An image-only body gives Readability nothing to extract: the fallback
    // path must apply the same elision the article path does.
    expect(mode).toBe('document')
    expect(markdown).toContain('![inline diagram](data:image/png;base64,...3.0KB)')
    expect(markdown).not.toContain('A'.repeat(64))
  })

  it('distrusts a noise-fragment extraction of a portal page and keeps the lists', () => {
    const { markdown, mode } = htmlToMarkdown(PORTAL_PAGE, 'https://example.com/')
    // Readability's pick on this shape is the 95-character licensing block
    // (verified against the 163.com homepage it was minimized from); the
    // coverage gate must reject it so the sanitized whole document — with
    // every column of headlines — is returned instead.
    expect(mode).toBe('document')
    expect(markdown).toContain('第1条中超冠军属于大连英博队')
    expect(markdown).toContain('第35条中超冠军属于大连英博队')
    expect(markdown).toContain('第70条中超冠军属于大连英博队')
    // The licensing text is still page content; it is kept, just no longer
    // allowed to be the ONLY thing kept.
    expect(markdown).toContain('粤B2-20090191-18')
  })

  it('distrusts an editorial fragment that covers a sliver of a list page', () => {
    const { markdown, mode } = htmlToMarkdown(CHANNEL_PAGE, 'https://example.com/')
    // The 480-character link-free preamble clears the 250-character floor
    // but covers 480/5229 ≈ 9% of the page; only the coverage ratio can
    // catch this shape (the sina.com.cn badcase).
    expect(mode).toBe('document')
    expect(markdown).toContain('编辑导语文字')
    expect(markdown).toContain('频道列表第1条标题某地发布最新政策引发广泛关注与讨论1')
    expect(markdown).toContain('频道列表第160条标题某地发布最新政策引发广泛关注与讨论160')
  })

  it('still trusts the article on text-rich article pages', () => {
    const { markdown, mode } = htmlToMarkdown(RICH_ARTICLE_PAGE, 'https://example.com/notes')
    // ~1.6k visible characters with the article covering the overwhelming
    // majority: the gate must stay out of the article path's way.
    expect(mode).toBe('article')
    expect(markdown).toContain('Structured concurrency gives every fetch a deadline')
    expect(markdown).toContain('which extraction path produced the markdown')
    expect(markdown).not.toContain('nav noise')
    expect(markdown).not.toContain('footer noise')
    expect(markdown).not.toContain('LIMITED TIME')
  })

  it('prunes the post-article recommendation rail the scorer cannot name', () => {
    const { markdown, mode } = htmlToMarkdown(DY_ARTICLE_PAGE, 'https://www.163.com/dy/article/LBA8924U05199NPP.html')
    // Readability's winner wrapper carries the rail (verified: every card's
    // ~0.42 density clears its own cleaning), so the extraction is accepted
    // in article mode — the trailing link-dense prune then strips the rail.
    expect(mode).toBe('article')
    // The article and the platform disclaimer both survive.
    expect(markdown).toContain('封顶仪式')
    expect(markdown).toContain('中山大学附属第一医院')
    expect(markdown).toContain('特别声明')
    // The rail is gone wholesale: headers, card titles, thumbnails,
    // authors, and timestamps — plus the out-of-extraction 40-link list.
    expect(markdown).not.toContain('相关推荐')
    expect(markdown).not.toContain('热点推荐')
    expect(markdown).not.toContain('浓眉哥')
    expect(markdown).not.toContain('篮球实战宝典')
    expect(markdown).not.toContain('2026-11-08 17:34:43')
    expect(markdown).not.toContain('/thumb1.jpg')
    expect(markdown).not.toContain('条推荐阅读标题')
  })

  it('keeps a rail that dominates a sparse extraction (dominant-share guard)', () => {
    const { markdown, mode } = htmlToMarkdown(SPARSE_ARTICLE_WITH_RAIL, 'https://example.com/brief')
    // Under the gate's body-text floor the extraction is trusted however
    // short — but the rail here holds over 60% of the article's text, and
    // the prune never guts an extraction: Readability's pick is returned
    // as delivered rather than second-guessed into a stub.
    expect(mode).toBe('article')
    expect(markdown).toContain('一句话短讯')
    expect(markdown).toContain('相关推荐')
  })

  it('keeps a link-bearing closing paragraph that is not a link farm', () => {
    const { markdown, mode } = htmlToMarkdown(RICH_ARTICLE_CLOSING_LINKS, 'https://example.com/pool-notes')
    // Three inline citation links inside a ~190-character paragraph measure
    // ~0.23 link density — nowhere near the link-farm bar; nothing earlier
    // in the article is link-dense either, so the prune must be a no-op.
    expect(mode).toBe('article')
    // Readability resolves the relative hrefs against the page URL.
    expect(markdown).toContain('[deadline guide](https://example.com/a)')
    expect(markdown).toContain('[lease design note](https://example.com/b)')
    expect(markdown).toContain('[timeout taxonomy](https://example.com/c)')
    expect(markdown).toContain('worked diagrams')
  })

  it('survives pathological input without throwing', () => {
    expect(() => htmlToMarkdown('', 'https://example.com/x')).not.toThrow()
    expect(() => htmlToMarkdown('<html><body>', 'https://example.com/x')).not.toThrow()
    const { markdown } = htmlToMarkdown('<p>hello</p>', 'https://example.com/x')
    expect(markdown.toLowerCase()).toContain('hello')
  })
})
