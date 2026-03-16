"""Google Search Agent definition for ADK Gemini Live API Toolkit demo."""

import os

from google.adk.agents import Agent
from google.adk.tools import google_search


agent = Agent(
    name="liveagent",
    model=os.getenv(
        "DEMO_AGENT_MODEL", "gemini-2.5-flash-native-audio-preview-09-2025"
    ),
    tools=[google_search],
    instruction="You are a helpful assistant that can search the web.",
)