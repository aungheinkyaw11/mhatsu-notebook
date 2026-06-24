# GitHub and Vercel Deployment Checklist

Use this checklist to push HmatSu to GitHub and deploy it on Vercel.

## 1. Confirm the App Builds Locally

```bash
npm install
npm run build
```

The build should finish without errors.

## 2. Commit the Final Code

```bash
git status
git add .
git commit -m "Prepare HmatSu for Vercel deployment"
```

## 3. Push to GitHub

```bash
git push origin main
```

After pushing, open your GitHub repository and confirm the README, screenshots, and source files are visible.

## 4. Import the Project in Vercel

1. Go to `https://vercel.com`.
2. Click **Add New**.
3. Choose **Project**.
4. Import your GitHub repository.
5. Keep the Framework Preset as **Next.js**.

## 5. Configure Build Settings

Use these Vercel settings:

```text
Framework Preset: Next.js
Install Command: npm install
Build Command: npm run build
Output Directory: leave empty
Root Directory: ./
```

No custom `vercel.json` is required.

## 6. Add Environment Variables

Add this required Production environment variable:

```text
GEMINI_API_KEY=your_gemini_api_key
```

Optional Supabase variables:

```text
NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
```

If you are only submitting the prototype and using the in-app API key field, the app can still run without Supabase.

## 7. Deploy

Click **Deploy**.

When the deployment finishes:

1. Open the Vercel live URL.
2. Test uploading a PDF.
3. Test Gemini connection.
4. Generate chat, quiz, flashcards, slides, and mind map.
5. Copy the live URL for your submission form and LinkedIn post.

## 8. Submission Links to Prepare

Before submitting the proof form, prepare:

- GitHub repository link
- Vercel live application link
- Public LinkedIn post link

Submit the proof form only once before **28 June 2026**.
