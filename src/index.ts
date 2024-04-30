

import 'dotenv/config';
import node from './node';

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY as string;
const YOUTUBE_CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID as string;

const main = async () => {
  const channelUrl = "https://www.youtube.com/@buildshipapp";
  // const channelUrl = "https://www.youtube.com/channel/UC1_8S7ffEDaOjcnjWOlRRlg";

  const response = await node({ channelUrl: channelUrl, apiKey: YOUTUBE_API_KEY }, { auth: YOUTUBE_API_KEY, logging: console, workflow: { id: "workflow_id" } });
  console.log(response);
};

main().catch(console.error);