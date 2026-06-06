# How to Set Up Supabase for Obsidian Sync

Welcome! This step-by-step guide is designed to help anyone set up their Supabase backend for the **Supabase Vault Sync** plugin, even if you have no programming or database experience. 

Supabase provides the secure cloud database and storage bucket that will safely hold your Obsidian notes and attachments. The Free Tier is more than enough for personal use.

---

## Step 1: Create a Supabase Project

1. Go to [Supabase.com](https://supabase.com/) and click **Start your project**.
2. Sign in with your GitHub account or create a new Supabase account.
3. Click the green **New Project** button.
4. Fill in the details:
   - **Name**: Give your project a name (e.g., "Obsidian Sync").
   - **Database Password**: Create a strong password (you can use the built-in generator). Make sure to save it somewhere safe!
   - **Region**: Choose the region closest to where you live for the fastest sync speed.
   - **Pricing Plan**: Select the **Free plan**.
5. Click **Create new project**. 
   > ⏳ *Note: It will take a few minutes for Supabase to provision your new database. Grab a coffee and wait until the project dashboard fully loads.*

---

## Step 2: Set Up the Database Tables & Security

Once your project is ready, we need to create the database tables to store your notes and set up security rules so only *you* can access your files. We have provided a script that does this automatically.

1. In your Supabase project dashboard, look at the left sidebar and click on **SQL Editor** (the icon looks like a terminal window `>_`).
2. Click **New query** (or the **+** button) to open a blank editor.
3. Copy the entire contents of the `schema.sql` file from this plugin. You can find it [here](https://github.com/dsnbyte/obsidian-supabase-sync/blob/main/schema.sql).
4. Paste the code into the SQL Editor in Supabase.
5. Click the **Run** button at the bottom right.
6. Look for a green success message (e.g., "Success. No rows returned"). 

> **What did this do?** This script automatically created the `obsidian_vault_files` table (for your notes), the `obsidian_sync_devices` table (to track your devices), and a secure storage bucket named `obsidian-vault-binaries` (for your images and PDFs). It also enabled strict **Row Level Security (RLS)** to guarantee that your data is completely isolated and private.

---

## Step 3: Create Your User Account

The plugin uses secure Email & Password authentication. You need to create an account for yourself within your new database.

1. In the left sidebar of Supabase, click on **Authentication** (the user icon).
2. Click on **Users** in the sub-menu.
3. Click the **Add User** button at the top right, then select **Create new user**.
4. Enter your **Email Address** and a **Password** that you will use to log into the plugin from Obsidian.
5. **Important Checkbox**: Leave the "Auto-confirm user?" box **checked**.
6. Click **Create user**.

> **Pro Tip (Disable Email Confirmation):** By default, Supabase requires you to click a link sent to your email before you can log in. To skip this and make logging in easier:
> - Go to **Authentication** -> **Providers** (under Configuration in the sidebar).
> - Click on **Email**.
> - Toggle the **Confirm email** switch to **OFF**.
> - Click **Save**.

---

## Step 4: Get Your Connection Details

Finally, you need two pieces of information from Supabase to paste into Obsidian.

1. In the left sidebar of Supabase, click on the **Project Settings** (the gear icon at the very bottom).
2. Click on **API** under the Configuration section.
3. Look for the **Project URL**. Copy this URL (it will look like `https://abcdefghijklmnop.supabase.co`).
4. Look for the **Project API keys**. Copy the key labeled **`anon` `public`**.

---

## Step 5: Connect Obsidian to Supabase

You're done with the Supabase website! Now let's connect the plugin:

1. Open Obsidian and go to **Settings** -> **Supabase Vault Sync**.
2. Paste your **Project URL** into the first field.
3. Paste your **anon API Key** into the second field.
4. Click **Test Connection**. A notification should confirm that the database and storage are accessible.
5. In the **Authentication** section, enter the Email and Password you created in Step 3 and click **Log In**.
6. Enter a **Vault ID** (e.g., `personal` or `work`). This is a unique namespace that keeps your vaults separate, allowing you to sync multiple Obsidian vaults to this exact same Supabase project!
7. Ensure your **Device Name** looks correct (it will try to auto-detect your computer's name).

**You are now fully set up and ready to sync your vault securely! 🎉**
