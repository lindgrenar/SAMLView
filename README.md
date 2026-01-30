SAMLView is designed to capture, decode, and visualize SAML authentication flows to aid troubleshooting.

**Features include:**
* Automatically detects and isolates SAMLRequest, SAMLResponse, and SAMLArtifact messages from network traffic.
* Visualizes the interaction between the Service Provider (SP), Browser, and Identity Provider (IdP) in a sequence diagram.
* Automatically decodes Base64 payloads and parses critical XML fields including Issuer, NameID, Audience, and AttributeStatements.
* Handles standard GET/POST bindings and provides automatic inflation for compressed (deflate-raw) SAMLRequests using the DecompressionStream API.
* Captures based on a single chosen tab, automatically includes any spawned tabs, redirects, or similar.
* Supports exporting and importing.

Screenshots can be found with the extension @ [Mozilla Add-on](https://addons.mozilla.org/en-US/firefox/addon/samlview/). 
