# SafeReach

**Created by:** Mithesh Balusamy and Sarvesh Govindaraj  
**Project:** Congressional App Challenge

## About SafeReach

SafeReach is a student-built web app designed to help people find nearby emergency shelters and hospitals in one place. It brings location search, a map, destination details, and driving directions together so people can more easily identify where help may be available during an emergency or community crisis.

## What it does

- **Find nearby help:** Search for shelters and hospitals using device location when available, or search by ZIP code.
- **Explore a map:** View nearby locations on an interactive map and open a location from its map marker.
- **Browse and filter results:** Use the Locations page to review results and filter between shelters and hospitals.
- **View route information:** Get driving routes and turn-by-turn directions when routing data is available.
- **Share a route:** Create a route-map image that includes the destination, route overview, trip summary, and directions. The image can be saved or shared using options supported by the device.
- **Keep useful information available offline:** Previously saved locations, route details, and map tiles may remain available on the device when the internet connection is lost. Offline information may be out of date.
- **Personalize the experience:** Choose light, dark, or system appearance and select a supported language: English, Spanish, Chinese, or Hindi.

## How to use it

1. Open SafeReach and choose **Search near me** or **Search by ZIP**.
2. Review the map on the **Find** page.
3. Open **Locations** to browse results and filter by shelters or hospitals.
4. Select a location to view details, then request or open its route and directions when available.
5. Use **Share route map** to create an image for saving or sharing.
6. Visit **Settings** to change language or appearance preferences.

## How it works

SafeReach combines public facility datasets and community-mapped information to identify possible nearby shelters and hospitals. It uses mapping tools to display locations and routing services to generate driving directions. When online sources are unavailable, the app may use previously saved information or a bundled fallback dataset.

The main technologies include:

- **HTML, CSS, and JavaScript** for the user interface and interactive features
- **Python and Flask** for the data and routing API
- **Leaflet** for interactive maps
- **Browser storage and a service worker** to retain supported data and app resources on the device

## Data sources and acknowledgments

SafeReach can use publicly available information from FEMA / the American Red Cross National Shelter System, HIFLD hospital-location data, OpenStreetMap, U.S. hospital data published through CMS, and ReliefWeb / HDX disaster information. Route information is provided through the OSRM routing service. Which sources respond may vary, so the locations shown are not guaranteed to be complete.

OpenStreetMap data and map tiles are subject to OpenStreetMap's attribution and usage requirements. Data providers retain their respective rights to their datasets and services.

## Important information

SafeReach is an informational aid, not an official emergency dispatch service. A listing does not guarantee that a facility is open, accepting people, or suitable for a particular emergency. Capacity information, when shown, reflects figures reported by the source and **is not a live occupancy count**. Saved and offline data can be outdated. When possible, verify critical details with the relevant facility or official emergency-management sources. In an immediate emergency, contact local emergency services.

## Creators

**Mithesh Balusamy**  
**Sarvesh Govindaraj**
