const express = require('express');
const axios = require('axios');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv');
const fs = require('fs').promises;
const path = require('path');
const { Console } = require('console');

puppeteer.use(StealthPlugin());
dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

const CACHE_TTL = 120 * 1000; // 2 minutes in milliseconds
const CACHE_FILE = path.join(__dirname, 'cached.json');
const MAX_POSTS = 50; // Maximum posts to fetch

app.use(cors({ origin: 'https://i-scrap.onrender.com' }));
app.use(express.json());
app.use('/images', express.static(path.join(__dirname, 'public/images')));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Rate limit exceeded. Please try again later.', status: 429 },
});
app.use(limiter);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getRandomUserAgent = () => {
  const agents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  ];
  return agents[Math.floor(Math.random() * agents.length)];
};

const ensureImagesDir = async () => {
  const dir = path.join(__dirname, 'public/images');
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (error) {
    console.error(`Failed to create images directory: ${error.message}`);
  }
};

const downloadMedia = async (url, filePath, isVideo = false) => {
  if (!url) {
    console.error('No URL provided for media download');
    return null;
  }
  try {
    const response = await axios({
      url,
      method: 'GET',
      responseType: 'stream',
      headers: { 'User-Agent': getRandomUserAgent() },
    });
    const writer = require('fs').createWriteStream(filePath);
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        console.log(`Successfully downloaded media to ${filePath}`);
        resolve(filePath);
      });
      writer.on('error', (error) => {
        console.error(`Failed to write media to ${filePath}: ${error.message}`);
        reject(error);
      });
    });
  } catch (error) {
    console.error(`Failed to download media from ${url}: ${error.message}`);
    return null;
  }
};

const readCache = async () => {
  try {
    const data = await fs.readFile(CACHE_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error(`Failed to read cache: ${error.message}`);
    return {};
  }
};

const writeCache = async (cache) => {
  try {
    await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (error) {
    console.error(`Failed to write cache: ${error.message}`);
  }
};

const cleanCache = async () => {
  let cache = await readCache();
  for (const key in cache) {
    if (Date.now() - cache[key].timestamp >= CACHE_TTL) {
      delete cache[key];
    }
  }
  await writeCache(cache);
};

const fetchWithRetry = async (url, options, retries = 3, delayMs = 2000) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await axios.get(url, options);
    } catch (error) {
      if (i === retries - 1) throw error;
      console.log(`Retry ${i + 1}/${retries} for ${url}: ${error.message}`);
      await delay(delayMs * (i + 1));
    }
  }
};

async function fetchInstagramApi(username) {
  await ensureImagesDir();
  try {
    let allPosts = [];
    let endCursor = null;
    let hasNextPage = true;

    // Fetch user ID and initial posts
    const initialResponse = await fetchWithRetry(
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${username}`,
      {
        headers: {
          'User-Agent': getRandomUserAgent(),
          'X-IG-App-ID': '936619743392459',
          'Accept': 'application/json',
        },
      }
    );

    const user = initialResponse.data?.data?.user;
    console.log("check testttt:",initialResponse)
    if (!user) {
      throw { status: 404, message: `Instagram user '${username}' not found.` };
    }

    // Handle private accounts
    if (user.is_private) {
      let profilePicPath = null;
      if (user.profile_pic_url_hd || user.profile_pic_url) {
        const profilePicUrl = user.profile_pic_url_hd || user.profile_pic_url;
        const fileName = `profile_${username}_${Date.now()}.jpg`;
        const filePath = path.join(__dirname, 'public/images', fileName);
        const downloadedPath = await downloadMedia(profilePicUrl, filePath);
        profilePicPath = downloadedPath ? `/images/${fileName}` : null;
      }
      return {
        username: user.username || username,
        full_name: user.full_name || null,
        biography: user.biography || '',
        media_count: user.edge_owner_to_timeline_media?.count || 0,
        follower_count: user.edge_followed_by?.count || 0,
        following_count: user.edge_follow?.count || 0,
        profile_pic_url: user.profile_pic_url_hd || user.profile_pic_url || null,
        profile_pic_path: profilePicPath,
        is_verified: user.is_verified || false,
        category: user.category_name || null,
        is_private: true,
        bio_links: user.bio_links?.map((link) => ({
          url: link.url,
          title: link.title || link.url,
        })) || [],
        posts: [],
        caption: user.accessibility_caption || null,
        message: 'This account is private. Like counts and full post data are not accessible without authentication.',
      };
    }

    const userId = user.id;
    let profilePicPath = null;
    if (user.profile_pic_url_hd || user.profile_pic_url) {
      const profilePicUrl = user.profile_pic_url_hd || user.profile_pic_url;
      const fileName = `profile_${username}_${Date.now()}.jpg`;
      const filePath = path.join(__dirname, 'public/images', fileName);
      const downloadedPath = await downloadMedia(profilePicUrl, filePath);
      profilePicPath = downloadedPath ? `/images/${fileName}` : null;
    }

    // Add initial posts
    allPosts = user.edge_owner_to_timeline_media?.edges || [];
    hasNextPage = user.edge_owner_to_timeline_media?.page_info?.has_next_page || false;
    endCursor = user.edge_owner_to_timeline_media?.page_info?.end_cursor || null;

    console.log(`Initial posts fetched: ${allPosts.length}, hasNextPage: ${hasNextPage}, endCursor: ${endCursor}, userId: ${userId}`);

    // Fetch additional posts until no more pages or max posts reached
    while (hasNextPage && endCursor && allPosts.length < MAX_POSTS) {
      try {
        await delay(2000);
        const nextResponse = await fetchWithRetry(
          `https://www.instagram.com/graphql/query/`,
          {
            params: {
              query_hash: '69cba40317214236af40e7efa697781d',
              variables: JSON.stringify({
                id: userId,
                first: Math.min(50, MAX_POSTS - allPosts.length),
                after: endCursor,
              }),
            },
            headers: {
              'User-Agent': getRandomUserAgent(),
              'X-IG-App-ID': '936619743392459',
              'Accept': 'application/json',
            },
          }
        );

        const nextPosts = nextResponse.data?.data?.user?.edge_owner_to_timeline_media?.edges || [];
        console.log("test check:", nextResponse)
        allPosts = [...allPosts, ...nextPosts];
        console.log("test check2:", allPosts)
        hasNextPage = nextResponse.data?.data?.user?.edge_owner_to_timeline_media?.page_info?.has_next_page || false;
        endCursor = nextResponse.data?.data?.user?.edge_owner_to_timeline_media?.page_info?.end_cursor || null;

        console.log(`Additional posts fetched: ${nextPosts.length}, total: ${allPosts.length}, hasNextPage: ${hasNextPage}, endCursor: ${endCursor}`);
      } catch (error) {
        console.log('Error fetching additional posts:', error.message, error.response?.status);
        break;
      }
    }

    // Limit to MAX_POSTS
    allPosts = allPosts.slice(0, MAX_POSTS);

    // Debug potential collaborative posts
    allPosts.forEach(edge => {
      const caption = edge.node.edge_media_to_caption?.edges[0]?.node?.text || '';
      if (caption.toLowerCase().includes('with') || caption.includes('@') || edge.node.is_collaborative || edge.node.coauthors?.length > 0) {
        console.log(`Potential collab post: ${edge.node.shortcode}, caption: ${caption}, coauthors: ${JSON.stringify(edge.node.coauthors)}`);
      }
    });

    // Sort posts: collabs first, then by timestamp (descending)
    allPosts.sort((a, b) => {
      const aCollab = a.node.is_collaborative || a.node.coauthors?.length > 0;
      const bCollab = b.node.is_collaborative || b.node.coauthors?.length > 0;
      if (aCollab && !bCollab) return -1;
      if (!aCollab && bCollab) return 1;
      return (b.node.taken_at_timestamp || 0) - (a.node.taken_at_timestamp || 0);
    });

    // Process posts
    const postsWithLocalThumbnails = await Promise.all(
      allPosts.map(async (edge) => {
        const thumbnailUrl = edge.node.thumbnail_src || edge.node.display_url;
        const mediaUrl = edge.node.is_video ? edge.node.video_url : thumbnailUrl;
        const timestamp = edge.node.taken_at_timestamp || null;
        const isCollaborative = edge.node.is_collaborative || edge.node.coauthors?.length > 0 || false;
        const coauthors = edge.node.coauthors?.map(coauthor => coauthor.username) || [];
        const caption = edge.node.edge_media_to_caption?.edges[0]?.node?.text || '';
        const accessibilityCaption = edge.node.accessibility_caption || null; // Extract accessibility_caption
        const likeCount = edge.node.edge_liked_by?.count || 0;
        const captionCollab = caption.toLowerCase().includes('with') || caption.includes('@');
        if (captionCollab && !isCollaborative) {
          const taggedUsers = caption.match(/@[\w.]+/g)?.map(tag => tag.slice(1)) || [];
          coauthors.push(...taggedUsers);
        }
        if (!mediaUrl) {
          console.log(`No media URL for post ${edge.node.shortcode}`);
          return {
            url: `https://www.instagram.com/p/${edge.node.shortcode}/`,
            thumbnail: null,
            thumbnail_path: null,
            video_url: null,
            timestamp,
            is_collaborative: isCollaborative || captionCollab,
            coauthors,
            is_video: edge.node.is_video || false,
            like_count: 0,
            like_count: likeCount, // Use extracted like count
            accessibility_caption: accessibilityCaption, // Include in response
          };
        }
        const fileExt = edge.node.is_video ? 'mp4' : 'jpg';
        const fileName = `post_${username}_${edge.node.shortcode}_${Date.now()}.${fileExt}`;
        const filePath = path.join(__dirname, 'public/images', fileName);
        const downloadedPath = await downloadMedia(mediaUrl, filePath, edge.node.is_video);
        return {
          url: `https://www.instagram.com/p/${edge.node.shortcode}/`,
          thumbnail: thumbnailUrl,
          thumbnail_path: edge.node.is_video ? null : (downloadedPath ? `/images/${fileName}` : null),
          video_url: edge.node.is_video ? (downloadedPath ? `/images/${fileName}` : null) : null,
          timestamp,
          is_collaborative: isCollaborative || captionCollab,
          coauthors,
          is_video: edge.node.is_video || false,
          like_count: 0,
          like_count: likeCount, // Use extracted like count
          accessibility_caption: accessibilityCaption, // Include in response
        };
      })
    );

    return {
      username: user.username || username,
      full_name: user.full_name || null,
      biography: user.biography || '',
      media_count: user.edge_owner_to_timeline_media?.count || postsWithLocalThumbnails.length,
      follower_count: user.edge_followed_by?.count || 0,
      following_count: user.edge_follow?.count || 0,
      profile_pic_url: user.profile_pic_url_hd || user.profile_pic_url || null,
      profile_pic_path: profilePicPath,
      is_verified: user.is_verified || false,
      category: user.category_name || null,
      is_private: user.is_private || false,
      bio_links: user.bio_links?.map((link) => ({
        url: link.url,
        title: link.title || link.url,
      })) || [],
      posts: postsWithLocalThumbnails,
      caption:  null,
    };
  } catch (error) {
    console.log('fetchInstagramApi error:', error.message, error.response?.status);
    throw { status: error.response?.status || 500, message: error.message || 'Failed to fetch Instagram API data.' };
  }
}

async function scrapeInstagram(username) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();

    await page.setUserAgent(getRandomUserAgent());
    await page.setViewport({ width: 1280, height: 2800 });

    await page.goto(`https://www.instagram.com/${username}/`, {
      waitUntil: 'networkidle0',
      timeout: 30000,
    });

    // Handle cookie consent
    const cookieButton = await page.$('button[data-testid="cookie-accept"]');
    if (cookieButton) {
      await cookieButton.click();
      await delay(1000);
    }

    const isNotFound = await page.evaluate(() => {
      const h2 = document.querySelector('h2');
      return h2 && h2.textContent.includes("Sorry, this page isn't available");
    });
    if (isNotFound) {
      throw new Error(`Instagram user '${username}' not found.`);
    }

    const isPrivate = await page.evaluate(() => {
      const h2 = document.querySelector('h2');
      return h2?.textContent.includes('This Account is Private');
    });
    if (isPrivate) {
      return {
        username,
        is_private: true,
        full_name: null,
        follower_count: null,
        following_count: null,
        media_count: null,
        biography: null,
        category: null,
        is_verified: false,
        profile_pic_url: null,
        profile_pic_path: null,
        bio_links: [],
        posts: [],
        message: 'This account is private. Full post data, including collaborative posts, is not accessible without authentication.',
      };
    }

    let allPosts = [];
    let hasMore = true;
    let lastHeight = 0;
    let sameHeightCount = 0;
    const maxSameHeight = 65;

    const mediaCount = await page.evaluate(() => {
      const stats = document.querySelectorAll('span[class*="_ac2b"]');
      return stats[0] ? parseInt(stats[0].textContent.replace(/[^0-9]/g, '')) || 0 : 0;
    });

    while (hasMore && allPosts.length < Math.min(mediaCount, MAX_POSTS)) {
      const posts = await page.evaluate(() => {
        const postElements = document.querySelectorAll('div[class*="_aabd"] a[href*="/p/"]');
        return Array.from(postElements).map((post) => {
          const thumbnail = post.querySelector('img')?.src || null;
          const timeElement = post.closest('article')?.querySelector('time');
          let timestamp = null;
          if (timeElement) {
            const dateTime = timeElement.getAttribute('datetime');
            if (dateTime) {
              timestamp = Math.floor(new Date(dateTime).getTime() / 1000);
            }
          }
          const header = post.closest('article')?.querySelector('header');
          const coauthorElements = header?.querySelectorAll('a[href*="/"]') || [];
          const collabIndicator = header?.querySelector('span[class*="_aacl"], span[class*="_acm2"]')?.textContent.toLowerCase().includes('with');
          const coauthors = [];
          let isCollaborative = collabIndicator || coauthorElements.length > 1;
          if (isCollaborative && coauthorElements.length > 1) {
            coauthorElements.forEach((el, idx) => {
              if (idx > 0) {
                const username = el.href.split('/').filter(Boolean).pop();
                if (username) coauthors.push(username);
              }
            });
          }
          const captionElement = post.closest('article')?.querySelector('div[class*="_a9zs"] span');
          const caption = captionElement?.textContent || '';
          const captionCollab = caption.toLowerCase().includes('with') || caption.includes('@');
          if (captionCollab && !isCollaborative) {
            const taggedUsers = caption.match(/@[\w.]+/g)?.map(tag => tag.slice(1)) || [];
            coauthors.push(...taggedUsers);
            isCollaborative = true;
          }
          const isVideo = !!post.closest('article')?.querySelector('video');
          const videoUrl = isVideo ? post.closest('article')?.querySelector('video')?.src : null;

          // Extract like count
          let likeCount = 0;
          const likeElement = post.closest('article')?.querySelector('section[class*="_ae5m"] span');
          if (likeElement) {
            const likeText = likeElement.textContent.replace(/,/g, '').match(/\d+/);
            likeCount = likeText ? parseInt(likeText[0]) : 0;
          }

          console.log(`Post ${post.href}: is_collaborative=${isCollaborative}, coauthors=${JSON.stringify(coauthors)}, caption=${caption}, is_video=${isVideo}, likes=${likeCount}`);
          return {
            url: post.href,
            thumbnail,
            accessibility_caption: accessibilityCaption,
            timestamp,
            is_collaborative: isCollaborative,
            coauthors,
            is_video: isVideo,
            video_url: videoUrl,
            like_count: likeCount,
          };
        });
      });

      allPosts = [...new Set([...allPosts, ...posts.map(p => JSON.stringify(p))])].map(JSON.parse);

      console.log(`Scraped posts: ${allPosts.length}`);

      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await delay(3000);

      const newHeight = await page.evaluate(() => document.body.scrollHeight);
      if (newHeight === lastHeight) {
        sameHeightCount++;
        if (sameHeightCount >= maxSameHeight) {
          hasMore = false;
          console.log('No more posts to load (same height reached)');
        }
      } else {
        sameHeightCount = 0;
        lastHeight = newHeight;
      }

      if (allPosts.length >= Math.min(mediaCount, MAX_POSTS)) {
        hasMore = false;
      }
    }

    // Limit to MAX_POSTS
    allPosts = allPosts.slice(0, MAX_POSTS);

    // Debug collaborative posts
    const collabCount = allPosts.filter(post => post.is_collaborative).length;
    console.log(`Collaborative posts scraped: ${collabCount}`);

    // Sort posts
    allPosts.sort((a, b) => {
      if (a.is_collaborative && !b.is_collaborative) return -1;
      if (!a.is_collaborative && b.is_collaborative) return 1;
      return (b.timestamp || 0) - (a.timestamp || 0);
    });

    // Extract user data
    const userData = await page.evaluate(() => {
      const getText = (selector) => {
        const element = document.querySelector(selector);
        return element ? element.textContent.trim() : null;
      };

      const getNumber = (text) => {
        if (!text) return 0;
        const num = parseInt(text.replace(/[^0-9]/g, ''));
        return isNaN(num) ? 0 : num;
      };

      const fullName = getText('h2[class*="_aacl"]') || getText('h1');
      const bio = getText('div[class*="_aacy"]') || getText('span[class*="_aacy"]');
      const stats = document.querySelectorAll('span[class*="_ac2b"]');
      const postsCount = stats[0] ? getNumber(stats[0].textContent) : 0;
      const followersCount = stats[1] ? getNumber(stats[1].textContent) : 0;
      const followingCount = stats[2] ? getNumber(stats[2].textContent) : 0;
      const profilePic = document.querySelector('img[alt*="profile picture"]')?.src || null;
      const isVerified = !!document.querySelector('svg[aria-label="Verified"]');
      const category = getText('span[class*="_aacl"][data-testid="user-profile-header-category"]');

      const bioLinks = [];
      const linkElements = document.querySelectorAll('a[href*="http"]');
      linkElements.forEach((link) => {
        const url = link.href;
        const title = link.textContent.trim();
        if (url && (url.includes('linktr.ee') || url.includes('http'))) {
          bioLinks.push({ url, title });
        }
      });

      return {
        username: window.location.pathname.replace(/\//g, ''),
        full_name: fullName,
        biography: bio,
        media_count: postsCount,
        follower_count: followersCount,
        following_count: followingCount,
        profile_pic_url: profilePic,
        is_verified: isVerified,
        category: category,
        is_private: false,
        bio_links: bioLinks,
        
      caption: accessibilityCaption,
      };
    });

    if (!userData || !userData.username) {
      const html = await page.content();
      await fs.writeFile('debug.html', html);
      throw new Error('Failed to extract user data from Instagram.');
    }

    // Download profile picture
    let profilePicPath = null;
    if (userData.profile_pic_url) {
      const fileName = `profile_${username}_${Date.now()}.jpg`;
      const filePath = path.join(__dirname, 'public/images', fileName);
      const downloadedPath = await downloadMedia(userData.profile_pic_url, filePath);
      profilePicPath = downloadedPath ? `/images/${fileName}` : null;
    }

    // Download thumbnails and videos
    const postsWithLocalThumbnails = await Promise.all(
      allPosts.map(async (post) => {
        if (!post.thumbnail && !post.video_url) {
          console.log(`No media for post ${post.url}`);
          return { ...post, thumbnail_path: null, video_url: null };
        }
        const shortcode = post.url.split('/p/')[1]?.replace('/', '') || '';
        const fileExt = post.is_video ? 'mp4' : 'jpg';
        const mediaUrl = post.is_video ? post.video_url : post.thumbnail;
        const fileName = `post_${username}_${shortcode}_${Date.now()}.${fileExt}`;
        const filePath = path.join(__dirname, 'public/images', fileName);
        const downloadedPath = await downloadMedia(mediaUrl, filePath, post.is_video);
        return {
          ...post,
          thumbnail_path: post.is_video ? null : (downloadedPath ? `/images/${fileName}` : null),
          video_url: post.is_video ? (downloadedPath ? `/images/${fileName}` : null) : null,
        };
      })
    );

    return {
      ...userData,
      profile_pic_path: profilePicPath,
      posts: postsWithLocalThumbnails,
    };
  } catch (error) {
    console.log('scrapeInstagram error:', error.message);
    throw { status: 500, message: error.message || 'Failed to scrape Instagram data.' };
  } finally {
    if (browser) await browser.close();
  }
}

app.post('/api/analyze-user', async (req, res) => {
  const { username } = req.body;

  if (!username || typeof username !== 'string' || username.trim() === '') {
    return res.status(400).json({ error: 'Invalid or missing username.' });
  }

  const trimmedUsername = username.trim();

  // Check cache
  let cache = await readCache();
  const cached = cache[trimmedUsername];
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`Returning cached data for ${trimmedUsername}: ${cached.data.posts.length} posts`);
    return res.json(cached.data);
  }

  try {
    const userData = await fetchInstagramApi(trimmedUsername);
    cache[trimmedUsername] = {
      data: userData,
      timestamp: Date.now(),
    };
    await writeCache(cache);
    console.log(`Final data for ${trimmedUsername}: ${userData.posts.length} posts`);
    res.json(userData);
  } catch (error) {
    try {
      const userData = await scrapeInstagram(trimmedUsername);
      cache[trimmedUsername] = {
        data: userData,
        timestamp: Date.now(),
      };
      await writeCache(cache);
      console.log(`Final data for ${trimmedUsername}: ${userData.posts.length} posts`);
      res.json(userData);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Server error' });
    }
  } finally {
    await cleanCache();
  }
});

app.get('/', async(req, res) => {
  res.send('Server is running and reachable from the browser!');
})

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});