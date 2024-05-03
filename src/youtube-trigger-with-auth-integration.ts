// Imports the Scheduler library
import { CloudSchedulerClient } from "@google-cloud/scheduler";
import { OAuth2Client } from "google-auth-library";

/*
** Youtube Trigger imports
*/
import { Storage, Bucket } from '@google-cloud/storage';
import { google, youtube_v3 } from "googleapis";
import process from 'node:process';
import { URL } from 'node:url';
/*
** Youtube Trigger imports
*/

const schedulerClient = new CloudSchedulerClient();

const getTarget = (runtimeUrl, workflowId) => ({
  uri: `${runtimeUrl}/executeWorkflow/${workflowId}`,
  httpMethod: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  oidcToken: {
    serviceAccountEmail: `runtime@${process.env.GCLOUD_PROJECT}.iam.gserviceaccount.com`,
    audience: process.env.GCLOUD_PROJECT + "/" + workflowId,
  },
});

const locationIds = [
  "asia-east1",
  "asia-northeast1",
  "asia-southeast1",
  "europe-north1",
  "europe-west1",
  "us-central1",
  "us-east1",
  "us-east4",
  "us-west1"
];

const createTrigger = async (
  { schedule, timeZone },
  { workflow, runtimeUrl }
) => {
  /**
 *  Required. The location name. For example:
 *  `projects/PROJECT_ID/locations/LOCATION_ID`.
 */
  let locationId = process.env.SERVICE_REGION;
  locationId = locationIds.includes(locationId) ? locationId : "us-central1";
  const parent = `projects/${process.env.GCLOUD_PROJECT}/locations/${locationId}`;
  const name = `${parent}/jobs/rowy-workflow-${workflow.id}`;
  /**
    *  Required. The job to add. The user can optionally specify a name for the
    *  job in name google.cloud.scheduler.v1.Job.name. name google.cloud.scheduler.v1.Job.name cannot be the same as an
    *  existing job. If a name is not specified then the system will
    *  generate a random unique name that will be returned
    *  (name google.cloud.scheduler.v1.Job.name) in the response.
    */
  const httpTarget = getTarget(runtimeUrl, workflow.id);

  try {
    // Run request
    const response = await schedulerClient.createJob({
      parent,
      job: {
        name,
        schedule,
        timeZone,
        httpTarget,
      },
    });

    return response;
  } catch (error) {
    if (error.code === 6) {
      // 'ALREADY_EXISTS' error
      console.log(`Job ${name} already exists.`);
      return updateTrigger(
        { schedule, timeZone },
        { workflow, runtimeUrl }
      );
    } else {
      throw error;
    }
  }
};

const updateTrigger = async (
  { schedule, timeZone },
  { workflow, runtimeUrl }
) => {
  let locationId = process.env.SERVICE_REGION;
  locationId = locationIds.includes(locationId) ? locationId : "us-central1";
  const parent = `projects/${process.env.GCLOUD_PROJECT}/locations/${locationId}`;
  const name = `${parent}/jobs/rowy-workflow-${workflow.id}`;
  const httpTarget = getTarget(runtimeUrl, workflow.id);

  try {
    // Update Job
    const response = await schedulerClient.updateJob({
      job: {
        httpTarget,
        name,
        schedule,
        timeZone,
      },
    });

    return response;
  } catch {
    // Create Job if not exists
    const response = await schedulerClient.createJob({
      parent,
      job: {
        name,
        schedule,
        timeZone,
        httpTarget,
      },
    });

    return response;
  }
};

const deleteTrigger = async (_, { workflow }) => {
  let locationId = process.env.SERVICE_REGION;
  locationId = locationIds.includes(locationId) ? locationId : "us-central1";
  const parent = `projects/${process.env.GCLOUD_PROJECT}/locations/${locationId}`;
  const name = `${parent}/jobs/rowy-workflow-${workflow.id}`;
  const request = {
    name,
  };
  const response = await schedulerClient.deleteJob(request);
  return response;
};

const execute = async (params, context) => {
  const { request, workflow, logging, isTest } = context;
  if (isTest) {
    /*
    ** execute Youtube Trigger
    */
    const triggerOutput = await executeYoutubeTrigger(params, context);
    /*
    ** execute Youtube Trigger
    */
    return {
      /*
      ** Youtube Trigger result
      */
      output: triggerOutput,
      /*
      ** Youtube Trigger result
      */
    }
  }
  const client = new OAuth2Client(process.env.GCLOUD_PROJECT);
  const token = request.headers.authorization?.split(" ")[1];

  if (!token) {
    throw new Error(
      "Missing authorization header or invalid format, needs to be in format: Bearer <IdToken>"
    );
  }

  try {
    const audience = process.env.GCLOUD_PROJECT + "/" + workflow.id;
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: audience,
    });

    const payload = ticket.getPayload();

    if (!payload.email_verified) {
      throw new Error("Email not verified.");
    }
  } catch (error) {
    throw new Error("Token verification failed.");
  }

  /*
  ** execute Youtube Trigger
  */
  const triggerOutput = await executeYoutubeTrigger(params, context);
  /*
  ** execute Youtube Trigger
  */

  const ret = {
    query: request.query,
    headers: request.headers,
    body: {},
  };

  logging.log(ret);

  return {
    request: ret,
    /*
    ** Youtube Trigger result
    */
    output: triggerOutput,
    /*
    ** Youtube Trigger result
    */
  };
};

/*
** Youtube Trigger
*/

const youtubeClient = google.youtube('v3');

type Snapshot = {
  channelId: string;
  latestVideoPublishedAt: string;
  videos: youtube_v3.Schema$SearchResult[];
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

async function executeYoutubeTrigger(
  { channelUrl }: { channelUrl: string },
  { logging, workflow, auth }: any) {
  try {

    const storageClient = new Storage();
    const bucket = storageClient.bucket(process.env.BUCKET as string);

    // With auth integration
    const { access_token } = await auth.getToken();
    google.options({ auth: google.auth.fromAPIKey(access_token) });

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
    const isChannelIdMatches = latestSnapshot?.channelId === channelId;

    if (haveLatestSnapshot && isChannelIdMatches) {
      // If latest snapshot, fetch all videos after latest published date
      logging.log(`Looking for videos published after ${latestSnapshot.latestVideoPublishedAt}`);
      const timestamp = new Date(latestSnapshot.latestVideoPublishedAt).getTime();
      searchQuery.publishedAfter = new Date(timestamp + 1000).toISOString();
    } else {
      if (!haveLatestSnapshot) {
        logging.log(`No latest snapshot found, fetching recent 5 videos for initial snapshot`);
      }
      if (haveLatestSnapshot && !isChannelIdMatches) {
        logging.log(`Channel ID mismatch, fetching recent 5 videos for the new channel`);
      }
      // If no latest snapshot, fetch recent 10 videos for initial snapshot
      searchQuery.maxResults = 5;
    }

    const { data: searchResponse } = await youtubeClient.search.list(searchQuery);
    const newVideos = searchResponse.items || [];
    const newVideosSorted = newVideos.sort((a, b) =>
      sortByDate(b.snippet?.publishedAt ?? "", a.snippet?.publishedAt ?? ""));

    const latestVideo = newVideosSorted[0];
    if (haveLatestSnapshot && isChannelIdMatches) {
      if (newVideosSorted.length > 0) {
        logging.log(`Found ${newVideosSorted.length} new videos since last snapshot`);
        await saveLatestSnapshotToStorage(bucket)(workflow.id, {
          channelId,
          latestVideoPublishedAt: latestVideo?.snippet?.publishedAt ?? "",
          videos: newVideosSorted,
        });
      } else {
        logging.log("No new videos found since last snapshot");
      }
    } else {
      if (newVideosSorted.length > 0) {
        logging.log(`Found ${newVideosSorted.length} new videos for initial snapshot`);
        await saveLatestSnapshotToStorage(bucket)(workflow.id, {
          channelId,
          latestVideoPublishedAt: latestVideo?.snippet?.publishedAt ?? "",
          videos: newVideosSorted,
        });
      } else {
        logging.log("No videos found for initial snapshot");
      }
    }

    return {
      channelId,
      channelUrl,
      latestVideoPublishedAt: latestVideo?.snippet?.publishedAt || latestSnapshot?.latestVideoPublishedAt || "",
      newVideos: newVideosSorted.map((video) => ({
        id: video.id?.videoId ?? "",
        url: `https://www.youtube.com/watch?v=${video.id?.videoId}`,
        title: video.snippet?.title ?? "",
        description: video.snippet?.description ?? "",
        publishedAt: video.snippet?.publishedAt ?? "",
        thumbnail: video.snippet?.thumbnails?.high?.url ?? "",
      })),
      snapshot: latestVideo ? {
        channelId,
        latestVideoPublishedAt: latestVideo?.snippet?.publishedAt ?? "",
        videos: newVideosSorted,
      } : isChannelIdMatches ? latestSnapshot : null,
    }
  } catch (cause) {
    logging.error(cause);
    throw cause;
  }
}
/*
** Youtube Trigger
*/


export default {
  onCreate: createTrigger,
  onUpdate: updateTrigger,
  onDelete: deleteTrigger,
  onExecution: execute,
};