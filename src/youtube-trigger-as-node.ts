import { Storage, Bucket } from '@google-cloud/storage';
import { google, youtube_v3 } from "googleapis";
import process from 'node:process';
import { URL } from 'node:url';

const youtubeClient = google.youtube('v3');

type Snapshot = {
  channelId: string;
  latestPublishedAt: string;
  videos: any[];
}

function saveLatestSnapshotToStorage(bucket: Bucket) {
  return async function (workflowId: string, snapshot: Snapshot) {
    const [workflowFolderExists] = await bucket.file(workflowId + '/').exists();
    if (!workflowFolderExists) {
      const file = bucket.file(`${workflowId}/`);
      await file.save("");
    }
    const snapshotData = JSON.stringify(snapshot, null, 2);
    const file = bucket.file(`${workflowId}/youtube-trigger-snapshot.json`);
    await file.save(snapshotData);
  }
}

function getLatestSnapshotFromStorage(bucket: Bucket) {
  return async function (workflowId: string): Promise<Snapshot | null> {
    const file = bucket.file(`${workflowId}/youtube-trigger-snapshot.json`);
    const [exists] = await file.exists();
    if (exists) {
      const [snapshot] = await file.download();
      return JSON.parse(snapshot.toString("utf8"));
    }
    return null;
  }
}

async function getChannelIdFromUrl(channelUrl: string) {
  let url: URL;
  try {
    url = new URL(channelUrl);
  } catch (cause) {
    throw new Error(`Invalid URL: ${channelUrl}`);
  }
  if (url.hostname !== "www.youtube.com") {
    throw new Error(`Invalid URL: ${channelUrl}`);
  }

  let [, handle, channelId] = url.pathname.split("/");
  if (handle !== "channel") {
    if (handle?.slice(0, 1) !== "@") {
      throw new Error(`Invalid URL: ${channelUrl}`);
    }
    const forHandle = handle.slice(1);
    const { data: channelData } = await youtubeClient.channels.list({
      part: ["id"],
      forHandle,
    });
    channelId = channelData.items?.[0].id ?? "";
  }

  if (!channelId) {
    throw new Error(`Could not find channel id for ${channelUrl}`);
  }
  return channelId;
};

function sortByDate(a: string, b: string) {
  return new Date(a).getTime() - new Date(b).getTime();
}

export default async (
  { channelUrl, apiKey }: { channelUrl: string, apiKey: string },
  { logging, workflow, auth }: any) => {
  try {

    const storageClient = new Storage();
    const bucket = storageClient.bucket(process.env.BUCKET as string);
    google.options({ auth: google.auth.fromAPIKey(apiKey) });

    const channelId = await getChannelIdFromUrl(channelUrl);
    logging.log("Channel ID: ", channelId);

    const latestSnapshot = await getLatestSnapshotFromStorage(bucket)(workflow.id);
    logging.log("Latest Snapshot: ", latestSnapshot);

    const searchQuery = {
      part: ["snippet"],
      channelId,
      order: "date",
    } as {
      part: string[],
      channelId: string,
      order: string,
      publishedAfter?: string,
      maxResults?: number
    };

    const haveLatestSnapshot = !!latestSnapshot;
    if (haveLatestSnapshot) {
      // If latest snapshot, fetch all videos after latest published date
      logging.log(`Looking for videos published after ${latestSnapshot.latestPublishedAt}`);
      const timestamp = new Date(latestSnapshot.latestPublishedAt).getTime();
      searchQuery.publishedAfter = new Date(timestamp + 1000).toISOString();
    } else {
      // If no latest snapshot, fetch recent 10 videos for initial snapshot
      logging.log(`No latest snapshot found, fetching recent 10 videos for initial snapshot`);
      searchQuery.maxResults = 10;
    }

    const { data: searchResponse } = await youtubeClient.search.list(searchQuery);
    const videos = searchResponse.items || [];
    const videosSorted = videos.sort((a, b) =>
      sortByDate(b.snippet?.publishedAt ?? "", a.snippet?.publishedAt ?? ""));

    const latestVideo = videosSorted[0];

    if (!haveLatestSnapshot) {
      if (videosSorted.length > 0) {
        logging.log(`Found ${videosSorted.length} new videos for initial snapshot`);
        await saveLatestSnapshotToStorage(bucket)(workflow.id, {
          channelId,
          latestPublishedAt: latestVideo?.snippet?.publishedAt ?? "",
          videos: videosSorted,
        });
      } else {
        logging.log("No videos found for initial snapshot");
      }
    } else {
      if (videosSorted.length > 0) {
        logging.log(`Found ${videosSorted.length} new videos since last snapshot`);
        await saveLatestSnapshotToStorage(bucket)(workflow.id, {
          channelId,
          latestPublishedAt: videosSorted[0].snippet?.publishedAt ?? "",
          videos: videosSorted,
        });
      } else {
        logging.log("No new videos found since last snapshot");
      }
    }

    return {
      hasNewVideos: videosSorted.length > 0,
      snapshot: {
        channelId,
        latestPublishedAt: latestVideo?.snippet?.publishedAt ?? "",
        videos: videosSorted,
      },
      recentSnapshot: latestSnapshot
    }
  } catch (cause) {
    logging.error(cause);
    throw cause;
  }
}