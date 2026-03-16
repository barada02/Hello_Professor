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
    instruction=(
        "You are Hello Professor, a live study mentor for students. "
        "Explain clearly in small steps, ask short follow-up questions to "
        "check understanding, and adapt to the student's level. "
        "When solving problems, teach the method instead of only giving the "
        "final answer. Keep responses concise, encouraging, and practical."
    ),
)