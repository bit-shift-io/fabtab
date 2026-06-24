
var rss_queue = [];
const RSS_FETCH_TIMEOUT_MS = 10000;
const TIER_STAGGER_MS = [100, 0, 0, 0, 0]; // rss2json needs breathing room; CORS proxies don't
const MAX_ITEMS = 8;

function read_rss_into_element(elementName, url) {
    rss_queue.push({ elementName, url });
}

function init_rss_feed(elementName, url, feedId) {
    const isCollapsed = localStorage.getItem('feed_collapsed_' + feedId) === 'true';
    if (isCollapsed) {
        const feedBlock = document.getElementById('feed-block-' + feedId);
        if (feedBlock) feedBlock.classList.add('collapsed');
        const toggle = document.getElementById('toggle-' + feedId);
        if (toggle) toggle.innerHTML = '+';
    } else {
        read_rss_into_element(elementName, url);
    }
}

function toggle_feed(feedId, rssUrl) {
    const feedBlock = document.getElementById('feed-block-' + feedId);
    const toggle = document.getElementById('toggle-' + feedId);
    if (!feedBlock) return;

    const isCollapsed = feedBlock.classList.toggle('collapsed');
    localStorage.setItem('feed_collapsed_' + feedId, isCollapsed);

    if (isCollapsed) {
        if (toggle) toggle.innerHTML = '+';
    } else {
        if (toggle) toggle.innerHTML = '-';
        const content = document.getElementById(feedId + '_link');
        if (content && content.querySelector('.loading-container')) {
            const feed = { elementName: feedId + '_link', url: rssUrl };
            if (rssUrl.includes('newsapi')) {
                processNewsapi(feed);
            } else {
                pushToTier(0, feed);
            }
        }
    }
}

// https://stackoverflow.com/questions/7394748/whats-the-right-way-to-decode-a-string-that-has-special-html-entities-in-it/7394787
function decodeHtml(html) {
    return he.decode(html);
}

/**
 * Randomize array element order in-place.
 * Using Durstenfeld shuffle algorithm.
 */
function shuffleArray(array) {
    for (var i = array.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var temp = array[i]; array[i] = array[j]; array[j] = temp;
    }
}

const append_to_content = (content, item) => {
    var itemContainer = document.createElement('LI');
    var itemLinkElement = document.createElement('A');
    itemLinkElement.className = "feed-item";
    itemLinkElement.setAttribute('target', '_blank');
    itemLinkElement.setAttribute('href', decodeHtml(item.link));
    itemLinkElement.innerHTML = decodeHtml(item.title);
    itemContainer.appendChild(itemLinkElement);
    content.appendChild(itemContainer);
};

function renderItems(elementName, items) {
    const content = document.getElementById(elementName);
    if (!content) return;
    content.innerHTML = '';
    for (const item of items) append_to_content(content, item);
}

function renderFailed(elementName) {
    const content = document.getElementById(elementName);
    if (!content) return;
    content.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'feed-failed';
    p.textContent = 'Failed to load';
    content.appendChild(p);
}

// Parse XML string to items; handles base64 data URIs (allorigins) and RSS/Atom formats
function parseXmlFeed(text) {
    let xmlString = text;
    if (xmlString && xmlString.startsWith('data:')) {
        xmlString = atob(xmlString.split(',')[1]);
    }
    const parser = new DOMParser();
    const xml = parser.parseFromString(xmlString, 'text/xml');
    if (xml.querySelector('parsererror')) throw new Error('XML parse error');
    // RSS 2.0 uses <item>, Atom uses <entry>
    let elements = [...xml.querySelectorAll('item')];
    const isAtom = elements.length === 0;
    if (isAtom) elements = [...xml.querySelectorAll('entry')];
    if (elements.length === 0) throw new Error('no items');
    return elements.slice(0, MAX_ITEMS).map(el => ({
        title: el.querySelector('title')?.textContent || '',
        link: isAtom
            ? (el.querySelector('link')?.getAttribute('href') || '')
            : (el.querySelector('link')?.textContent || ''),
    }));
}

function fetchWithTimeout(url) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), RSS_FETCH_TIMEOUT_MS);
    return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timeoutId));
}

function fetchViaRss2Json(url) {
    return fetchWithTimeout('https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(url))
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(data => {
            if (data.status !== 'ok') throw new Error('rss2json: ' + data.status);
            return data.items.slice(0, MAX_ITEMS).map(i => ({ title: i.title, link: i.link }));
        });
}

function fetchViaCorsproxy(url) {
    return fetchWithTimeout('https://corsproxy.io/?url=' + encodeURIComponent(url))
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
        .then(text => parseXmlFeed(text));
}

function fetchViaCodetabs(url) {
    return fetchWithTimeout('https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(url))
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
        .then(text => parseXmlFeed(text));
}

function fetchViaThingproxy(url) {
    return fetchWithTimeout('https://thingproxy.freeboard.io/fetch/' + url)
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
        .then(text => parseXmlFeed(text));
}

function fetchViaAllOrigins(url) {
    return fetchWithTimeout('https://api.allorigins.win/raw?url=' + encodeURIComponent(url))
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
        .then(text => parseXmlFeed(text));
}

//
// Tier queue architecture
//
// Each tier is an independent sequential queue. Failures from tier N are pushed
// into tier N+1 as they happen — tiers run concurrently, each at their own pace.
// The 100ms gap between attempts within a tier gives each service breathing room.
//
// Tier 0: rss2json    (RSS-to-JSON API)
// Tier 1: corsproxy   (CORS proxy, XML parsed in browser)
// Tier 2: codetabs    (CORS proxy, XML parsed in browser)
// Tier 3: thingproxy  (CORS proxy, XML parsed in browser)
// Tier 4: allorigins  (CORS proxy, XML parsed in browser)
//
const RSS_STRATEGIES = [fetchViaRss2Json, fetchViaCorsproxy, fetchViaCodetabs, fetchViaThingproxy, fetchViaAllOrigins];
const rss_tiers = [[], [], [], [], []];
const tier_running = [false, false, false, false, false];

function pushToTier(tierIndex, feed) {
    if (tierIndex >= RSS_STRATEGIES.length) {
        renderFailed(feed.elementName);
        return;
    }
    rss_tiers[tierIndex].push(feed);
    if (!tier_running[tierIndex]) {
        processTier(tierIndex);
    }
}

async function processTier(tierIndex) {
    tier_running[tierIndex] = true;
    const queue = rss_tiers[tierIndex];
    const strategy = RSS_STRATEGIES[tierIndex];

    while (queue.length > 0) {
        const feed = queue.shift();
        try {
            const items = await strategy(feed.url);
            renderItems(feed.elementName, items);
        } catch (_) {
            pushToTier(tierIndex + 1, feed);
        }
        if (queue.length > 0 && TIER_STAGGER_MS[tierIndex] > 0) {
            await new Promise(resolve => setTimeout(resolve, TIER_STAGGER_MS[tierIndex]));
        }
    }

    tier_running[tierIndex] = false;
}

// newsapi feeds bypass the tier system — fetch directly, no fallback needed
function processNewsapi(feed) {
    var xhr = new XMLHttpRequest();
    xhr.onload = function () {
        if (xhr.status == 200) {
            const data = JSON.parse(xhr.responseText);
            const content = document.getElementById(feed.elementName);
            if (!content) return;
            content.innerHTML = '';
            for (var i = 0, t = Math.min(MAX_ITEMS, data.articles.length); i < t; ++i) {
                var { title, url: articleUrl } = data.articles[i];
                append_to_content(content, { title, link: articleUrl });
            }
        }
    };
    xhr.open('GET', feed.url, true);
    xhr.send();
}

var is_processing = false;
function start_process_rss_queue() {
    if (is_processing) return;
    is_processing = true;
    shuffleArray(rss_queue);
    for (const feed of rss_queue.splice(0)) {
        if (feed.url.includes('newsapi')) {
            processNewsapi(feed);
        } else {
            pushToTier(0, feed);
        }
    }
}

// https://stackoverflow.com/questions/11381673/detecting-a-mobile-browser
window.mobilecheck = function () {
    var check = false;
    (function (a) { if (/(android|bb\d+|meego).+mobile|avantgo|bada\/|blackberry|blazer|compal|elaine|fennec|hiptop|iemobile|ip(hone|od)|iris|kindle|lge |maemo|midp|mmp|mobile.+firefox|netfront|opera m(ob|in)i|palm( os)?|phone|p(ixi|re)\/|plucker|pocket|psp|series(4|6)0|symbian|treo|up\.(browser|link)|vodafone|wap|windows ce|xda|xiino/i.test(a) || /1207|6310|6590|3gso|4thp|50[1-6]i|770s|802s|a wa|abac|ac(er|oo|s\-)|ai(ko|rn)|al(av|ca|co)|amoi|an(ex|ny|yw)|aptu|ar(ch|go)|as(te|us)|attw|au(di|\-m|r |s )|avan|be(ck|ll|nq)|bi(lb|rd)|bl(ac|az)|br(e|v)w|bumb|bw\-(n|u)|c55\/|capi|ccwa|cdm\-|cell|chtm|cldc|cmd\-|co(mp|nd)|craw|da(it|ll|ng)|dbte|dc\-s|devi|dica|dmob|do(c|p)o|ds(12|\-d)|el(49|ai)|em(l2|ul)|er(ic|k0)|esl8|ez([4-7]0|os|wa|ze)|fetc|fly(\-|_)|g1 u|g560|gene|gf\-5|g\-mo|go(\.w|od)|gr(ad|un)|haie|hcit|hd\-(m|p|t)|hei\-|hi(pt|ta)|hp( i|ip)|hs\-c|ht(c(\-| |_|a|g|p|s|t)|tp)|hu(aw|tc)|i\-(20|go|ma)|i230|iac( |\-|\/)|ibro|idea|ig01|ikom|im1k|inno|ipaq|iris|ja(t|v)a|jbro|jemu|jigs|kddi|keji|kgt( |\/)|klon|kpt |kwc\-|kyo(c|k)|le(no|xi)|lg( g|\/(k|l|u)|50|54|\-[a-w])|libw|lynx|m1\-w|m3ga|m50\/|ma(te|ui|xo)|mc(01|21|ca)|m\-cr|me(rc|ri)|mi(o8|oa|ts)|mmef|mo(01|02|bi|de|do|t(\-| |o|v)|zz)|mt(50|p1|v )|mwbp|mywa|n10[0-2]|n20[2-3]|n30(0|2)|n50(0|2|5)|n7(0(0|1)|10)|ne((c|m)\-|on|tf|wf|wg|wt)|nok(6|i)|nzph|o2im|op(ti|wv)|oran|owg1|p800|pan(a|d|t)|pdxg|pg(13|\-([1-8]|c))|phil|pire|pl(ay|uc)|pn\-2|po(ck|rt|se)|prox|psio|pt\-g|qa\-a|qc(07|12|21|32|60|\-[2-7]|i\-)|qtek|r380|r600|raks|rim9|ro(ve|zo)|s55\/|sa(ge|ma|mm|ms|ny|va)|sc(01|h\-|oo|p\-)|sdk\/|se(c(\-|0|1)|47|mc|nd|ri)|sgh\-|shar|sie(\-|m)|sk\-0|sl(45|id)|sm(al|ar|b3|it|t5)|so(ft|ny)|sp(01|h\-|v\-|v )|sy(01|mb)|t2(18|50)|t6(00|10|18)|ta(gt|lk)|tcl\-|tdg\-|tel(i|m)|tim\-|t\-mo|to(pl|sh)|ts(70|m\-|m3|m5)|tx\-9|up(\.b|g1|si)|utst|v400|v750|veri|vi(rg|te)|vk(40|5[0-3]|\-v)|vm40|voda|vulc|vx(52|53|60|61|70|80|81|83|85|98)|w3c(\-| )|webc|whit|wi(g |nc|nw)|wmlb|wonu|x700|yas\-|your|zeto|zte\-/i.test(a.substr(0, 4))) check = true; })(navigator.userAgent || navigator.vendor || window.opera);
    return check;
};


//
// Background load/fade
//
function load_bg() {
    if (window.mobilecheck()) {
        return;
    }

    const imageUrl = "https://source.unsplash.com/random/1920x1080?scenic";
    let bgElement = document.querySelector(".bg-lazy");
    bgElement.classList.add("bg-loading");
    let preloaderImg = document.createElement("img");
    preloaderImg.src = imageUrl;

    preloaderImg.addEventListener('load', (event) => {
        bgElement.classList.remove("bg-loading");
        bgElement.style.backgroundImage = `url(${imageUrl})`;
        preloaderImg = null;
    });
}
